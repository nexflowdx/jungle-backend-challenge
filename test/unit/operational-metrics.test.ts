import { expect, test } from 'bun:test';
import { OperationalMetrics, operationalMetrics } from '../../src/modules/operations/operational-metrics';
import { SqsWagerRetry } from '../../src/modules/messaging/infrastructure/sqs-wager-retry';
import { WagerProcessingRetryableError } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { OutboxPublicationCoordinator } from '../../src/modules/messaging/application/outbox-publication-coordinator';
import type { ReservedOutboxEvent } from '../../src/modules/messaging/application/outbox-reservation';

test('latency counts success/failure without replacing result identity or original errors', async () => {
  let clock = 0; const metrics = new OperationalMetrics(() => { clock += 10; return clock; });
  const result = { committed: true }; const failure = new Error('original');
  expect(await metrics.measureProcessing(async () => result)).toBe(result);
  await expect(metrics.measureProcessing(async () => { throw failure; })).rejects.toBe(failure);
  expect(metrics.snapshot().processingLatency).toMatchObject({ observations: '2', total: 20, maximum: 10, includesTransportAck: false });
});
test('clock failure never replaces financial result/error or fabricates duration', async () => {
  const metrics = new OperationalMetrics(() => { throw new Error('clock'); }); const failure = new Error('original');
  expect(await metrics.measureProcessing(async () => 'committed')).toBe('committed');
  await expect(metrics.measureProcessing(async () => { throw failure; })).rejects.toBe(failure);
  expect(metrics.snapshot().processingLatency.observations).toBe('0');
});

test('instance snapshots are ephemeral, isolated, JSON-safe and detached without financial identifiers', () => {
  const a = new OperationalMetrics(); const b = new OperationalMetrics();
  a.observeWager({ status: 'PROCESSED', idempotentReplay: true });
  a.observeWager({ status: 'REJECTED', idempotentReplay: false });
  a.observeWager({ status: 'PENDING_REFERENCE', idempotentReplay: false });
  for (const status of ['CONSISTENT', 'DIVERGENT', 'INCONCLUSIVE']) a.observeReconciliation(status);
  for (const code of ['40P01', '40001', '55P03', '57014']) a.observeSqlFailure({ code });
  const result = a.snapshot(); expect(result).toMatchObject({ scope: 'process-local', ephemeral: true });
  for (const name of ['wager_replays', 'wager_responses_processed', 'wager_responses_rejected', 'wager_responses_pending_reference',
    'reconciliation_consistent', 'reconciliation_divergent', 'reconciliation_inconclusive', 'deadlocks_observed', 'serialization_failures_observed', 'lock_unavailable_observed']) {
    expect(result.counters[name]).toBe('1');
  }
  expect(b.snapshot().counters.wager_replays).toBe('0'); expect(b.instanceId).not.toBe(a.instanceId);
  result.counters.wager_replays = '999'; expect(a.snapshot().counters.wager_replays).toBe('1');
  expect(JSON.stringify(result)).not.toContain('walletId');
});
test('unknown states and hostile infrastructure metadata cannot throw or invent counters', () => {
  const metrics = new OperationalMetrics(); const original = metrics.snapshot().counters;
  metrics.observeWager({ status: 'UNKNOWN', idempotentReplay: false }); metrics.observeReconciliation('UNKNOWN');
  metrics.observeSqlFailure({ get code() { throw new Error('secret'); } });
  expect(metrics.snapshot().counters).toEqual(original);
});
test.each([200, 500, undefined])('SQS retry counts only explicit confirmation, HTTP status %s', async httpStatusCode => {
  const config = { endpoint: 'http://localhost:4566', region: 'us-east-1', queueUrl: 'http://localhost:4566/000000000000/wager-transactions.fifo', visibilityTimeout: 30, waitTimeSeconds: 0 };
  const before = BigInt(operationalMetrics.snapshot().counters.sqs_visibility_retries_confirmed!);
  const retry = new SqsWagerRetry({ send: async () => ({ $metadata: httpStatusCode === undefined ? {} : { httpStatusCode } }) }, config, () => 0.5);
  const result = await retry.apply({ body: '{}', sqsMessageId: 'message', receiptHandle: 'receipt', messageGroupId: 'wallet', approximateReceiveCount: '1' },
    { phase: 'processing', financialOutcome: { kind: 'rolled-back' }, error: new WagerProcessingRetryableError('40001', new Error()) });
  expect(result.kind).toBe('retry-scheduled'); // Adapter contract is preserved even without confirmation.
  expect(BigInt(operationalMetrics.snapshot().counters.sqs_visibility_retries_confirmed!)).toBe(before + (httpStatusCode === 200 ? 1n : 0n));
});
test.each([true, false])('outbox retry counts only committed scheduling: %s', async scheduled => {
  const before = BigInt(operationalMetrics.snapshot().counters.outbox_retries_scheduled!);
  const coordinator = new OutboxPublicationCoordinator({ reserve: async () => [{ id: 'event', attempts: 1, leaseToken: 'lease' } as ReservedOutboxEvent] },
    { publish: async () => { throw new Error('network'); } }, { confirm: async () => true }, { schedule: async () => scheduled }, () => 0.5);
  expect((await coordinator.processOnce()).status).toBe(scheduled ? 'retry-scheduled' : 'retry-not-scheduled');
  expect(BigInt(operationalMetrics.snapshot().counters.outbox_retries_scheduled!)).toBe(before + (scheduled ? 1n : 0n));
});
