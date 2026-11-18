import { expect, mock, test } from 'bun:test';
import { ChangeMessageVisibilityCommand, type ChangeMessageVisibilityCommandOutput } from '@aws-sdk/client-sqs';
import { SqsWagerRetry } from '../../src/modules/messaging/infrastructure/sqs-wager-retry';
import type { ReceivedRawWagerRequest, SqsWagerConfiguration } from '../../src/modules/messaging/infrastructure/sqs-wager-receiver';
import type { WagerDeliveryFailure, WagerFailurePhase } from '../../src/modules/messaging/application/wager-delivery-policy';
import { WagerProcessingRetryableError } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { InvalidWagerMessageError } from '../../src/modules/messaging/application/wager-requested';
import { WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';

const config: SqsWagerConfiguration = { endpoint: 'http://localhost:4566', region: 'us-east-1',
  queueUrl: 'http://localhost:4566/000000000000/wager-transactions.fifo', visibilityTimeout: 30, waitTimeSeconds: 0 };
const delivery = (count = '1', receiptHandle = 'current-receipt'): ReceivedRawWagerRequest => Object.freeze({
  body: '{broken', sqsMessageId: 'message', receiptHandle, messageGroupId: 'wallet', approximateReceiveCount: count,
});
const transient = (): WagerDeliveryFailure => Object.freeze({ phase: 'processing',
  error: new WagerProcessingRetryableError('40001', new Error('serialization failure')), financialOutcome: { kind: 'rolled-back' as const } });
const client = () => ({ send: mock(async (_command: ChangeMessageVisibilityCommand): Promise<ChangeMessageVisibilityCommandOutput> => ({ $metadata: {} })) });

test.each([
  { count: '1', sample: 0, expected: 2 }, { count: '1', sample: 0.5, expected: 2 }, { count: '1', sample: 1, expected: 3 },
  { count: '2', sample: 0.25, expected: 4 }, { count: '3', sample: 0, expected: 7 }, { count: '4', sample: 1, expected: 20 },
])('explicit retry uses policy jitter and rounds visibility up %#', async ({ count, sample, expected }) => {
  const sqs = client(); const jitter = mock(() => sample); const retry = new SqsWagerRetry(sqs, config, jitter);
  expect(sqs.send).not.toHaveBeenCalled();
  const outcome = await retry.apply(delivery(count), transient());
  expect(outcome).toMatchObject({ kind: 'retry-scheduled', visibilityTimeout: expected, decision: { action: 'retry' } });
  expect(jitter).toHaveBeenCalledTimes(1); expect(sqs.send).toHaveBeenCalledTimes(1);
  const command = sqs.send.mock.calls[0]![0]; expect(command).toBeInstanceOf(ChangeMessageVisibilityCommand);
  expect(command.input).toEqual({ QueueUrl: config.queueUrl, ReceiptHandle: 'current-receipt', VisibilityTimeout: expected });
  expect(expected).toBeGreaterThanOrEqual(1); expect(expected).toBeLessThanOrEqual(60);
});

test.each(['5', '6', '9007199254740991'])('exhausted receipt %s defers DLQ without sending or deleting anything', async count => {
  const sqs = client();
  expect(await new SqsWagerRetry(sqs, config, () => 0.5).apply(delivery(count), transient()))
    .toMatchObject({ kind: 'deferred', decision: { action: 'send-to-dlq', exhausted: true } });
  expect(sqs.send).not.toHaveBeenCalled();
});

test('permanent validation failure defers the unimplemented DLQ without touching the receipt', async () => {
  const sqs = client();
  const failure: WagerDeliveryFailure = { phase: 'validation', error: new InvalidWagerMessageError(), financialOutcome: { kind: 'not-started' } };
  expect(await new SqsWagerRetry(sqs, config, () => 0.5).apply(delivery(), failure))
    .toMatchObject({ kind: 'deferred', decision: { action: 'send-to-dlq' } });
  expect(sqs.send).not.toHaveBeenCalled();
});

test.each(['validation', 'processing', 'commit', 'dlq', 'ack'] satisfies WagerFailurePhase[])('unknown failure in %s never sends a visibility or delete command', async phase => {
  const sqs = client(); const retry = new SqsWagerRetry(sqs, config, () => 0.5);
  for (const count of ['1', '5']) {
    const failure: WagerDeliveryFailure = { phase, error: new Error('unknown'), financialOutcome: { kind: 'rolled-back' } };
    expect(await retry.apply(delivery(count), failure)).toMatchObject({ kind: 'deferred', decision: { action: 'hold' } });
  }
  expect(sqs.send).not.toHaveBeenCalled();
});

test('familiar SQL exception is not evidence of rollback, including ambiguous COMMIT', async () => {
  const sqs = client(); const retry = new SqsWagerRetry(sqs, config, () => 0.5);
  for (const phase of ['processing', 'commit'] as const) {
    for (const count of ['1', '5']) {
      expect(await retry.apply(delivery(count), { ...transient(), phase, financialOutcome: { kind: 'uncertain' } }))
        .toMatchObject({ kind: 'deferred', decision: { action: 'hold', failure: { financialOutcome: { kind: 'uncertain' } } } });
    }
  }
  expect(sqs.send).not.toHaveBeenCalled();
});

test.each([Status.Processed, Status.Rejected, Status.PendingReference] as const)('ACK failure retains durable %s and sends no command', async status => {
  const sqs = client(); const financialOutcome = { kind: 'persisted' as const,
    result: { transactionId: 'transaction', status, balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false } };
  expect(await new SqsWagerRetry(sqs, config, () => 0.5).apply(delivery('5'), {
    phase: 'ack', error: new Error('DeleteMessage failed'), financialOutcome,
  })).toMatchObject({ kind: 'deferred', decision: { action: 'hold', failure: { phase: 'ack', financialOutcome } } });
  expect(sqs.send).not.toHaveBeenCalled();
});

test.each([undefined, '', ' ', '0', '-1', '1.5', '1e0', '01', '+1', '1 ', ' 1', '1\n', 'NaN', 'Infinity', '9007199254740992'])('invalid raw receive count %# never authorizes retry', async approximateReceiveCount => {
  const sqs = client(); const jitter = mock(() => 0.5);
  await expect(new SqsWagerRetry(sqs, config, jitter).apply({ ...delivery(), approximateReceiveCount }, transient())).rejects.toBeInstanceOf(RangeError);
  expect(sqs.send).not.toHaveBeenCalled(); expect(jitter).not.toHaveBeenCalled();
});

test.each([undefined, '', ' ', ' receipt', 'receipt ', 'with space', 'receipt\n', '\u0000'])('invalid raw receipt handle %# never authorizes retry', async receiptHandle => {
  const sqs = client();
  await expect(new SqsWagerRetry(sqs, config).apply({ ...delivery(), receiptHandle }, transient())).rejects.toBeInstanceOf(RangeError);
  expect(sqs.send).not.toHaveBeenCalled();
});

test('invalid injected jitter causes no visibility operation', async () => {
  const sqs = client();
  await expect(new SqsWagerRetry(sqs, config, () => NaN).apply(delivery(), transient())).rejects.toBeInstanceOf(RangeError);
  expect(sqs.send).not.toHaveBeenCalled();
});

test('visibility failure propagates unchanged, without deletion or a fabricated scheduled result', async () => {
  const error = new Error('ChangeMessageVisibility failed');
  const send = mock(async (_command: ChangeMessageVisibilityCommand): Promise<ChangeMessageVisibilityCommandOutput> => { throw error; });
  await expect(new SqsWagerRetry({ send }, config, () => 0.5).apply(delivery(), transient())).rejects.toBe(error);
  expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0]![0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
});

test('each redelivery uses the current receipt, never a cached handle', async () => {
  const sqs = client(); const retry = new SqsWagerRetry(sqs, config, () => 0.5);
  await retry.apply(delivery('1', 'first-receipt'), transient()); await retry.apply(delivery('2', 'fresh-receipt'), transient());
  expect(sqs.send.mock.calls.map(([command]) => command.input.ReceiptHandle)).toEqual(['first-receipt', 'fresh-receipt']);
});
