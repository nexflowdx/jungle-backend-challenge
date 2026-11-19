import { SQSClient, type DeleteMessageCommand } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction, type ProcessWagerTransactionResult } from '../../wagering/application/process-wager-transaction';
import type { WagerProcessingUnitOfWork } from '../../wagering/application/wager-processing-unit-of-work';
import { PostgresWagerProcessingUnitOfWork } from '../../wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { SqsWagerCommandHandler } from '../application/sqs-wager-command-handler';
import { InvalidWagerMessageError, parseWagerTransactionRequested } from '../application/wager-requested';
import type { WagerDeliveryFailure } from '../application/wager-delivery-policy';
import { SqsWagerDelivery, type SqsAckClient } from './sqs-wager-delivery';
import { SqsWagerReceiver, type ReceivedRawWagerRequest, type SqsWagerConfiguration } from './sqs-wager-receiver';
import { SqsWagerRetry } from './sqs-wager-retry';
import { SqsWagerDlq } from './sqs-wager-dlq';
import { ConsumerFinancialEvidence, ConsumerProcessingFailure } from './consumer-financial-evidence';
import { runSerialWorker, type SerialWorkerOptions } from '../../operations/serial-worker';
import { jsonLogger } from '../../operations/json-logger';

export interface ConsumerPorts {
  receive(stop: AbortSignal): Promise<ReceivedRawWagerRequest | undefined>;
  handler: Pick<SqsWagerCommandHandler, 'execute'>;
  ack(deadline: AbortSignal): SqsAckClient;
  retry(raw: ReceivedRawWagerRequest, failure: WagerDeliveryFailure): ReturnType<SqsWagerRetry['apply']>;
  dlq(raw: ReceivedRawWagerRequest, failure: WagerDeliveryFailure): Promise<unknown>;
}
export class ContinuousSqsConsumer {
  constructor(private readonly ports: ConsumerPorts, private readonly config: SqsWagerConfiguration) {}
  async process(raw: ReceivedRawWagerRequest, deadline: AbortSignal): Promise<void> {
    if (deadline.aborted) return;
    let envelope: ReturnType<typeof parseWagerTransactionRequested>;
    try {
      if (typeof raw.body !== 'string' || !raw.sqsMessageId?.trim() || !raw.receiptHandle?.trim()
        || !raw.messageGroupId || !/^[\x21-\x7e]{1,128}$/.test(raw.messageGroupId)) throw new InvalidWagerMessageError();
      envelope = parseWagerTransactionRequested(JSON.parse(raw.body));
    } catch {
      if (!deadline.aborted) await this.ports.dlq(raw, { phase: 'validation', error: new InvalidWagerMessageError(), financialOutcome: { kind: 'not-started' } });
      return;
    }
    let persisted: ProcessWagerTransactionResult | undefined;
    const handler = { execute: async (input: unknown) => { const result = await this.ports.handler.execute(input); persisted = result; return result; } };
    try {
      const ack = this.ports.ack(deadline);
      // Gate late completion even for injected clients; never delete after drain timeout.
      const gated = { send: (command: DeleteMessageCommand) => {
        if (deadline.aborted) throw new Error('Worker deadline exceeded');
        return ack.send(command);
      } };
      await new SqsWagerDelivery(handler, gated, this.config).execute({
        envelope, sqsMessageId: raw.sqsMessageId!, receiptHandle: raw.receiptHandle!, messageGroupId: raw.messageGroupId!,
      });
    } catch (error) {
      if (deadline.aborted) return;
      const failure: WagerDeliveryFailure = persisted ? { phase: 'ack', error, financialOutcome: { kind: 'persisted', result: persisted } }
        : error instanceof ConsumerProcessingFailure ? error.failure : { phase: 'processing', error, financialOutcome: { kind: 'uncertain' } };
      const decision = await this.ports.retry(raw, failure);
      if (!deadline.aborted && decision.kind === 'deferred' && decision.decision.action === 'send-to-dlq') await this.ports.dlq(raw, failure);
    }
  }
  run(stop: AbortSignal, options: SerialWorkerOptions) {
    return runSerialWorker(async deadline => {
      const raw = await this.ports.receive(stop);
      if (raw && !stop.aborted && !deadline.aborted) await this.process(raw, deadline);
    }, stop, options, () => jsonLogger.emit('error', 'worker.cycle_failed'));
  }
}
export function createContinuousConsumer(orm: MikroORM, client: SQSClient, config: SqsWagerConfiguration, dlqUrl: string,
  work: WagerProcessingUnitOfWork = new PostgresWagerProcessingUnitOfWork(orm)) {
  const evidence = new ConsumerFinancialEvidence(orm, work);
  const handler = new SqsWagerCommandHandler(new ProcessWagerTransaction(evidence));
  const dlq = new SqsWagerDlq(client, config, dlqUrl); const retry = new SqsWagerRetry(client, config);
  const consumer = new ContinuousSqsConsumer({ handler: { execute: envelope => evidence.observe(() => handler.execute(envelope)) },
    receive: stop => new SqsWagerReceiver({ send: command => client.send(command, { abortSignal: stop }) }, config).receiveRawOnce(),
    ack: deadline => ({ send: command => client.send(command, { abortSignal: deadline }) }),
    retry: (raw, failure) => retry.apply(raw, failure), dlq: (raw, failure) => dlq.apply(raw, failure),
  }, config);
  return { consumer, preflight: () => dlq.assertExplicitMode() };
}
