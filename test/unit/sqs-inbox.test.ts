import { expect, mock, test } from 'bun:test';
import { DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { assertSqsTestEnvironment } from '../helpers/sqs-test-environment';
import { bounded } from '../helpers/bun-process-client';
import { HttpMemoryPersistence } from '../helpers/http-memory-persistence';
import { OpenWallet } from '../../src/modules/wallets/application/open-wallet';
import { ProcessWagerTransaction, WagerResultUnavailableError } from '../../src/modules/wagering/application/process-wager-transaction';
import type { WagerProcessingUnitOfWork } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { WagerInboxConflictError } from '../../src/modules/wagering/application/wager-inbox';
import { WagerIdentityCollisionError } from '../../src/modules/wagering/application/wager-transaction-identity';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { SqsWagerCommandHandler } from '../../src/modules/messaging/application/sqs-wager-command-handler';
import { parseWagerTransactionRequested, type WagerTransactionRequested } from '../../src/modules/messaging/application/wager-requested';
import { wagerMessageIdentity } from '../../src/modules/messaging/application/wager-message-identity';
import { SqsWagerDelivery } from '../../src/modules/messaging/infrastructure/sqs-wager-delivery';
import type { SqsWagerConfiguration, ReceivedWagerRequest } from '../../src/modules/messaging/infrastructure/sqs-wager-receiver';

const config: SqsWagerConfiguration = { endpoint: 'http://localhost:4566', region: 'us-east-1', queueUrl: 'http://localhost:4566/000000000000/wager-transactions.fifo', visibilityTimeout: 30, waitTimeSeconds: 0 };
function envelope(walletId: string, overrides: Partial<WagerTransactionRequested['data']> = {}): WagerTransactionRequested {
  return parseWagerTransactionRequested({ messageId: 'envelope-message', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00Z',
    data: { providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key', playerId: 'player', walletId,
      gameId: 'game', roundId: 'round', kind: Kind.Bet, money: { amount: '25.00', currency: 'BRL' }, ...overrides } });
}
const delivery = (event: WagerTransactionRequested, receiptHandle = 'receipt-1'): ReceivedWagerRequest =>
  ({ envelope: event, receiptHandle, sqsMessageId: 'transport-' + receiptHandle, messageGroupId: event.data.walletId });
async function fixture(decorate: (work: WagerProcessingUnitOfWork) => WagerProcessingUnitOfWork = work => work) {
  const memory = new HttpMemoryPersistence();
  const wallet = await new OpenWallet(memory.walletOpening).execute({ playerId: 'player', correlationId: 'opening', initialBalance: { amount: '100.00', currency: 'BRL' } });
  const process = new ProcessWagerTransaction(decorate(memory.wagerProcessing)); const handler = new SqsWagerCommandHandler(process);
  const send = mock(async (_command: DeleteMessageCommand) => ({ $metadata: {} }));
  return { memory, wallet, process, handler, send, run: new SqsWagerDelivery(handler, { send }, config), event: envelope(wallet.id) };
}
function snapshot(memory: HttpMemoryPersistence) {
  return { wallets: [...memory.wallets.values()].map(wallet => ({ balance: wallet.balance.toJSON(), version: wallet.version })),
    transactions: [...memory.transactions.keys()], ledger: [...memory.ledger], outbox: [...memory.events], inbox: structuredClone([...memory.inbox]) };
}

test('message hash is stable across key order, exact money normalization and equivalent UTC timestamps', () => {
  const first = envelope('wallet');
  const other = parseWagerTransactionRequested({ data: { ...first.data, money: { currency: 'BRL', amount: '00025.00' } },
    occurredAt: '2026-07-29T15:00:00.000Z', type: first.type, messageId: first.messageId });
  expect(wagerMessageIdentity(other)).toEqual(wagerMessageIdentity(first));
  expect(wagerMessageIdentity(first).payloadHash).toMatch(/^[a-f0-9]{64}$/);
});
test.each(['amount', 'idempotencyKey', 'occurredAt', 'reference'] as const)('message hash includes validated %s', field => {
  const first = envelope('wallet', { kind: Kind.Win });
  const other = parseWagerTransactionRequested({ ...first, ...(field === 'occurredAt' ? { occurredAt: '2026-07-30T15:00:00Z' } : {}), data: {
    ...first.data, ...(field === 'amount' ? { money: { amount: '26.00', currency: 'BRL' } } : {}),
    ...(field === 'idempotencyKey' ? { idempotencyKey: 'another-key' } : {}), ...(field === 'reference' ? { referenceExternalTransactionId: 'bet' } : {}),
  } });
  expect(wagerMessageIdentity(other).payloadHash).not.toBe(wagerMessageIdentity(first).payloadHash);
});
test('first delivery commits inbox and financial effect before deletion; redelivery uses its new receipt only', async () => {
  const f = await fixture(); const first = await f.run.execute(delivery(f.event));
  expect(first).toMatchObject({ status: Status.Processed, balance: { amount: '75.00' }, idempotentReplay: false });
  const before = snapshot(f.memory); expect(f.memory.inbox.size).toBe(1); expect([...f.memory.inbox.values()][0]!.processedAt).toBeInstanceOf(Date);
  expect(f.send.mock.calls[0]![0]).toBeInstanceOf(DeleteMessageCommand);
  expect(f.send.mock.calls[0]![0].input).toEqual({ QueueUrl: config.queueUrl, ReceiptHandle: 'receipt-1' });
  expect(await f.run.execute(delivery(f.event, 'redelivery-receipt'))).toEqual({ ...first, idempotentReplay: true });
  expect(snapshot(f.memory)).toEqual(before); expect(f.send.mock.calls[1]![0].input.ReceiptHandle).toBe('redelivery-receipt');
});
test('a distinct message carrying a HTTP operation records only inbox and ACKs financial replay', async () => {
  const f = await fixture(); const first = await f.process.execute({ ...f.event.data, correlationId: 'http' });
  const before = snapshot(f.memory); expect(f.memory.inbox.size).toBe(0);
  expect(await f.run.execute(delivery(f.event))).toEqual({ ...first, idempotentReplay: true });
  expect(f.memory.inbox.size).toBe(1); expect(f.memory.ledger).toEqual(before.ledger); expect(f.memory.events).toEqual(before.outbox);
});
test('envelope identity is separate from financial identity and transport IDs', async () => {
  const f = await fixture(); await f.run.execute(delivery(f.event)); const before = snapshot(f.memory);
  const next = { ...f.event, messageId: 'new-logical-message' };
  expect((await f.run.execute(delivery(next))).idempotentReplay).toBe(true); expect(f.memory.inbox.size).toBe(2);
  expect(f.memory.ledger).toEqual(before.ledger); expect(f.memory.events).toEqual(before.outbox);
});
test('same message with different payload conflicts without changing inbox or ACKing', async () => {
  const f = await fixture(); await f.run.execute(delivery(f.event)); const before = snapshot(f.memory); f.send.mockClear();
  await expect(f.run.execute(delivery({ ...f.event, data: { ...f.event.data, money: { amount: '26.00', currency: 'BRL' } } }))).rejects.toBeInstanceOf(WagerInboxConflictError);
  expect(snapshot(f.memory)).toEqual(before); expect(f.send).not.toHaveBeenCalled();
});
test.each([Status.Rejected, Status.PendingReference])('%s is durable consumption and is ACKed, with stable financial replay', async status => {
  const f = await fixture(); const event = envelope(f.wallet.id, status === Status.Rejected ? { money: { amount: '101.00', currency: 'BRL' } }
    : { kind: Kind.Win, referenceExternalTransactionId: 'missing' });
  const first = await f.run.execute(delivery(event)); expect(first.status).toBe(status);
  if (status === Status.Rejected) expect(first.failureCode).toBe(FailureCode.InsufficientFunds);
  const before = snapshot(f.memory); expect(before.wallets[0]!.balance.amount).toBe('100.00'); expect(before.ledger).toHaveLength(1);
  expect(await f.run.execute(delivery(event, 'next'))).toEqual({ ...first, idempotentReplay: true });
  expect(snapshot(f.memory)).toEqual(before); expect(f.send).toHaveBeenCalledTimes(2);
});
test.each(['outbox', 'inbox-completion', 'commit-boundary'])('unit boundary failure at %s rolls back local state and sends no ACK', async point => {
  const f = await fixture(work => ({ transaction: callback => work.transaction(async scope => {
    const result = await callback({ ...scope,
      insertEvents: async events => { await scope.insertEvents(events); if (point === 'outbox') throw new Error(point); },
      inbox: { claim: (...args) => scope.inbox!.claim(...args), complete: async at => {
        await scope.inbox!.complete(at); if (point === 'inbox-completion') throw new Error(point);
      } },
    });
    if (point === 'commit-boundary') throw new Error(point); // Mocked boundary only; real deferred commit tested with SQL.
    return result;
  }) }));
  const before = snapshot(f.memory); await expect(f.run.execute(delivery(f.event))).rejects.toThrow(point);
  expect(snapshot(f.memory)).toEqual(before); expect(f.send).not.toHaveBeenCalled();
});
test('ACK waits for transaction resolution, even after the callback already produced a result', async () => {
  let commit!: () => void; let reached!: () => void;
  const gate = new Promise<void>(resolve => { commit = resolve; }); const callbackReached = new Promise<void>(resolve => { reached = resolve; }); const order: string[] = [];
  const f = await fixture(work => ({ transaction: callback => work.transaction(async scope => {
    const result = await callback(scope); order.push('callback'); reached(); await gate; order.push('commit-boundary'); return result;
  }) }));
  const send = mock(async (_command: DeleteMessageCommand) => { order.push('ack'); return { $metadata: {} }; });
  const pending = new SqsWagerDelivery(f.handler, { send }, config).execute(delivery(f.event));
  // Explicit barrier from the financial callback, without timers or sleeps.
  try {
    await bounded(Promise.race([callbackReached, pending.then(() => { throw new Error('Premature completion'); })]), 2000, 'callback barrier');
    expect(send).not.toHaveBeenCalled(); expect(f.memory.inbox.size).toBe(0);
  } finally { commit(); }
  await pending;
  expect(order).toEqual(['callback', 'commit-boundary', 'ack']); expect(f.memory.inbox.size).toBe(1);
});
test('ACK failure after commit propagates; redelivery does not repeat effects', async () => {
  const f = await fixture(); const failure = new Error('ack unavailable');
  const send = mock(async (_command: DeleteMessageCommand) => { throw failure; });
  await expect(new SqsWagerDelivery(f.handler, { send }, config).execute(delivery(f.event))).rejects.toBe(failure);
  const before = snapshot(f.memory); expect(before.wallets[0]!.balance.amount).toBe('75.00'); expect(f.memory.inbox.size).toBe(1);
  expect((await f.run.execute(delivery(f.event, 'fresh-receipt'))).idempotentReplay).toBe(true); expect(snapshot(f.memory)).toEqual(before);
});
test('identity UNIQUE recovery reclaims inbox only in a fresh transaction after rollback', async () => {
  const f = await fixture(); await f.process.execute({ ...f.event.data, correlationId: 'http' }); const before = snapshot(f.memory);
  let attempts = 0;
  const work: WagerProcessingUnitOfWork = { transaction: callback => f.memory.wagerProcessing.transaction(async scope => {
    attempts++;
    return callback(attempts === 1 ? { ...scope, findIdentityCandidates: async () => [], insertPending: async () => { throw new WagerIdentityCollisionError('idempotency-key'); } } : scope);
  }) };
  const handler = new SqsWagerCommandHandler(new ProcessWagerTransaction(work));
  expect((await new SqsWagerDelivery(handler, { send: f.send }, config).execute(delivery(f.event))).idempotentReplay).toBe(true);
  expect(attempts).toBe(3); expect(f.memory.inbox.size).toBe(1); expect(f.memory.ledger).toEqual(before.ledger); expect(f.memory.events).toEqual(before.outbox);
});
test('message processing fails closed on HTTP-only persistence without inbox capability', async () => {
  const f = await fixture(work => ({ transaction: callback => work.transaction(async scope => {
    const { inbox: _inbox, ...financialOnly } = scope; return callback(financialOnly);
  }) }));
  const before = snapshot(f.memory); await expect(f.run.execute(delivery(f.event))).rejects.toThrow('Atomic inbox persistence is unavailable');
  expect(snapshot(f.memory)).toEqual(before); expect(f.send).not.toHaveBeenCalled();
});
test('completed inbox without financial data fails closed instead of authorizing a new effect', async () => {
  const f = await fixture(); const identity = wagerMessageIdentity(f.event);
  f.memory.inbox.set(JSON.stringify([identity.consumerName, identity.messageId]), { ...identity, receivedAt: new Date(), processedAt: new Date() });
  const before = snapshot(f.memory); await expect(f.run.execute(delivery(f.event))).rejects.toBeInstanceOf(WagerResultUnavailableError);
  expect(snapshot(f.memory)).toEqual(before); expect(f.send).not.toHaveBeenCalled();
});
test('invalid delivery or envelope is rejected before persistence and ACK', async () => {
  const f = await fixture(); const before = f.memory.calls;
  await expect(f.run.execute({ ...delivery(f.event), receiptHandle: '' })).rejects.toThrow();
  await expect(f.run.execute({ ...delivery(f.event), envelope: { ...f.event, type: 'invalid' } as unknown as WagerTransactionRequested })).rejects.toThrow();
  expect(f.memory.calls).toBe(before); expect(f.send).not.toHaveBeenCalled();
});

test.each([
  { PGHOST: 'production-host' }, { SQS_ENDPOINT: 'https://sqs.us-east-1.amazonaws.com' }, { GITHUB_ACTIONS: 'false' },
])('real SQS test guard refuses unsafe environment %# before connections', override => {
  expect(() => assertSqsTestEnvironment({ GITHUB_ACTIONS: 'true', PERSISTENCE_TEST_CONTAINER: '1', PGHOST: 'postgres',
    PGDATABASE: 'jungle_persistence_test', PGUSER: 'diagnostic', PGPASSWORD: 'unit-only', SQS_ENDPOINT: 'http://ministack:4566', ...override })).toThrow();
});
