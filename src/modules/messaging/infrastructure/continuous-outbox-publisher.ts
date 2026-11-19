import type { MikroORM } from '@mikro-orm/postgresql';
import type { OutboxProcessingResult } from '../application/outbox-publication-coordinator';
import { createOutboxCoordinator } from './create-outbox-coordinator';
import { SqsOutboxPublisher, type SqsOutboxSendClient } from './sqs-outbox-publisher';
import { runSerialWorker, type SerialWorkerOptions } from '../../operations/serial-worker';
import { jsonLogger } from '../../operations/json-logger';

export function outboxClientWithDeadline(client: SqsOutboxSendClient, deadline: AbortSignal): SqsOutboxSendClient {
  return { send: (command, options) => {
    if (deadline.aborted) return Promise.reject(new Error('Worker deadline exceeded'));
    const abortSignal = options?.abortSignal ? AbortSignal.any([options.abortSignal, deadline]) : deadline;
    return client.send(command, { abortSignal });
  } };
}
export class ContinuousOutboxPublisher {
  constructor(private readonly processOnce: (deadline: AbortSignal) => Promise<OutboxProcessingResult>) {}
  run(stop: AbortSignal, options: SerialWorkerOptions) {
    return runSerialWorker(async deadline => { await this.processOnce(deadline); }, stop, options,
      () => jsonLogger.emit('error', 'worker.cycle_failed'));
  }
}
export function createContinuousPublisher(orm: MikroORM, client: SqsOutboxSendClient, queueUrl: string) {
  // Validate the existing queue contract before starting the loop. No I/O in constructor.
  new SqsOutboxPublisher(client, queueUrl);
  return new ContinuousOutboxPublisher(deadline => createOutboxCoordinator(orm, outboxClientWithDeadline(client, deadline), queueUrl).processOnce());
}
