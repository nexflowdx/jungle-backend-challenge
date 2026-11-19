import { expect, test } from 'bun:test';
import { ContinuousSqsConsumer, type ConsumerPorts } from '../../src/modules/messaging/infrastructure/continuous-sqs-consumer';
import { ConsumerProcessingFailure } from '../../src/modules/messaging/infrastructure/consumer-financial-evidence';
import { SqsWagerRetry } from '../../src/modules/messaging/infrastructure/sqs-wager-retry';
import { WagerProcessingRetryableError } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';
import type { ReceivedRawWagerRequest } from '../../src/modules/messaging/infrastructure/sqs-wager-receiver';
import { bounded } from '../helpers/bun-process-client';

const config = { endpoint: 'http://localhost:4566', region: 'us-east-1', queueUrl: 'http://localhost:4566/000000000000/wager-transactions.fifo', visibilityTimeout: 120, waitTimeSeconds: 10 };
const result = { transactionId: 'tx', status: Status.Processed as const, balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false };
const raw = (): ReceivedRawWagerRequest => ({ body: JSON.stringify({ messageId: 'envelope', type: 'WagerTransactionRequested', occurredAt: '2026-11-19T10:00:00Z',
  data: { providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key', playerId: 'player', walletId: 'wallet', roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } } }),
  sqsMessageId: 'transport', receiptHandle: 'receipt', messageGroupId: 'wallet', approximateReceiveCount: '1' });
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture(overrides: Partial<ConsumerPorts> = {}) {
  const calls = { receive: 0, process: 0, ack: 0, dlq: 0, retry: 0 }; let failure: unknown;
  const retry = new SqsWagerRetry({ send: async () => ({ $metadata: { httpStatusCode: 200 } }) }, config, () => 0.5);
  const ports: ConsumerPorts = { receive: async () => { calls.receive++; return raw(); },
    handler: { execute: async () => { calls.process++; return result; } },
    ack: () => ({ send: async () => { calls.ack++; return { $metadata: {} }; } }),
    retry: async (delivery, evidence) => { calls.retry++; failure = evidence; return retry.apply(delivery, evidence); },
    dlq: async (_, evidence) => { calls.dlq++; failure = evidence; }, ...overrides };
  return { consumer: new ContinuousSqsConsumer(ports, config), calls, failure: () => failure };
}
test('continuous loop is serial and does not start a new poll after stop', async () => {
  const stop = new AbortController(); let active = 0; let maximum = 0; let completed = 0;
  const f = fixture({ handler: { execute: async () => { maximum = Math.max(maximum, ++active); await Promise.resolve(); active--; return result; } },
    ack: () => ({ send: async () => { if (++completed === 3) stop.abort(); return { $metadata: {} }; } }) });
  expect(await f.consumer.run(stop.signal, { intervalMs: 10, shutdownGraceMs: 100 })).toBe('stopped');
  expect(completed).toBe(3); expect(maximum).toBe(1); expect(f.calls.receive).toBe(3);
});
test('receive failure is retained and a later delivery is processed without parallelism', async () => {
  const stop = new AbortController(); let polls = 0;
  const f = fixture({ receive: async () => { if (++polls === 1) throw new Error('receive'); return raw(); },
    ack: () => ({ send: async () => { stop.abort(); return { $metadata: {} }; } }) });
  expect(await f.consumer.run(stop.signal, { intervalMs: 10, shutdownGraceMs: 100 })).toBe('stopped'); expect(polls).toBe(2);
});
test('malformed envelope goes only to the existing DLQ policy with not-started evidence', async () => {
  const f = fixture(); await f.consumer.process({ ...raw(), body: '{' }, new AbortController().signal);
  expect(f.calls.process).toBe(0); expect(f.calls.ack).toBe(0); expect(f.calls.dlq).toBe(1);
  expect(f.failure()).toMatchObject({ phase: 'validation', financialOutcome: { kind: 'not-started' } });
});
test('an already-expired deadline performs no processing, ACK or DLQ operation', async () => {
  const deadline = new AbortController(); deadline.abort(); const f = fixture();
  await f.consumer.process(raw(), deadline.signal);
  expect(f.calls).toEqual({ receive: 0, process: 0, ack: 0, dlq: 0, retry: 0 });
});
test('confirmed rollback invokes existing retry; ambiguous processing and persisted ACK failures never invoke DLQ', async () => {
  const failure = new WagerProcessingRetryableError('40001', undefined);
  for (const kind of ['rolled-back', 'uncertain'] as const) {
    const f = fixture({ handler: { execute: async () => { throw new ConsumerProcessingFailure({ phase: 'processing', error: failure, financialOutcome: { kind } }); } } });
    await f.consumer.process(raw(), new AbortController().signal);
    expect(f.calls.retry).toBe(1); expect(f.calls.ack).toBe(0); expect(f.calls.dlq).toBe(0);
    expect(f.failure()).toMatchObject({ financialOutcome: { kind } });
  }
  const f = fixture({ ack: () => ({ send: async () => { throw new Error('ACK uncertain'); } }) });
  await f.consumer.process(raw(), new AbortController().signal);
  expect(f.failure()).toMatchObject({ phase: 'ack', financialOutcome: { kind: 'persisted', result } }); expect(f.calls.dlq).toBe(0);
});
test('redelivery calls the original handler again and ACKs its exact persisted replay', async () => {
  let executions = 0; const f = fixture({ handler: { execute: async () => ({ ...result, idempotentReplay: executions++ > 0 }) } });
  await f.consumer.process(raw(), new AbortController().signal); await f.consumer.process(raw(), new AbortController().signal);
  expect(executions).toBe(2); expect(f.calls.ack).toBe(2); expect(f.calls.dlq).toBe(0);
});
test('stop aborts pending long poll and discards a delivery returned after the signal', async () => {
  const stop = new AbortController(); const entered = barrier(); const returned = barrier();
  const f = fixture({ receive: async signal => { entered.release(); await returned.promise; expect(signal.aborted).toBe(true); return raw(); } });
  const running = f.consumer.run(stop.signal, { intervalMs: 10, shutdownGraceMs: 100 });
  await entered.promise; stop.abort(); returned.release();
  expect(await running).toBe('stopped'); expect(f.calls.process).toBe(0); expect(f.calls.ack).toBe(0);
});
test('stop waits for committed work then ACKs; drain timeout blocks every late ACK', async () => {
  for (const expire of [false, true]) {
    const stop = new AbortController(); const entered = barrier(); const complete = barrier();
    const f = fixture({ handler: { execute: async () => { entered.release(); await complete.promise; return result; } } });
    const running = f.consumer.run(stop.signal, { intervalMs: 10, shutdownGraceMs: expire ? 5 : 1000 });
    await entered.promise; expect(f.calls.ack).toBe(0); stop.abort();
    if (!expire) complete.release();
    expect(await bounded(running, 2000, 'consumer shutdown')).toBe(expire ? 'timed-out' : 'stopped');
    complete.release(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.calls.ack).toBe(expire ? 0 : 1); expect(f.calls.receive).toBe(1);
  }
});
