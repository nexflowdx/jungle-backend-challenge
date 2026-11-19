import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { JsonLogger } from '../../src/modules/operations/json-logger';
import { currentLogContext, runWithLogContext } from '../../src/modules/operations/log-context';
import { SqsWagerCommandHandler } from '../../src/modules/messaging/application/sqs-wager-command-handler';
import { SqsWagerDelivery } from '../../src/modules/messaging/infrastructure/sqs-wager-delivery';
import { SqsOutboxPublisher } from '../../src/modules/messaging/infrastructure/sqs-outbox-publisher';
import type { ReservedOutboxEvent } from '../../src/modules/messaging/application/outbox-reservation';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';
import { ProcessWagerTransaction } from '../../src/modules/wagering/application/process-wager-transaction';
import { OpenWallet } from '../../src/modules/wallets/application/open-wallet';
import { HttpMemoryPersistence } from '../helpers/http-memory-persistence';

const envelope = (messageId = 'envelope-id', walletId = 'wallet') => ({ messageId, type: 'WagerTransactionRequested', occurredAt: '2026-11-19T10:00:00Z',
  data: { providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key', playerId: 'player', walletId,
    roundId: 'round', gameId: 'game', kind: Kind.Bet, money: { amount: '25.00', currency: 'BRL' } } });
const result = { transactionId: 'transaction', status: Status.Processed as const, balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false };
const config = { endpoint: 'http://localhost:4566', region: 'us-east-1', queueUrl: 'http://localhost:4566/000000000000/wager-transactions.fifo', visibilityTimeout: 30, waitTimeSeconds: 0 };
const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };

test('concurrent SQS processing isolates envelope correlations and does not inherit surrounding HTTP identifiers', async () => {
  const lines: string[] = []; let arrived = 0; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const handler = new SqsWagerCommandHandler({ execute: async command => {
    if (!('correlationId' in command)) throw new Error('Unexpected unsupported command');
    const before = currentLogContext();
    expect(before.correlationId).toBe(command.correlationId); expect(before.messageId).toBe(command.correlationId);
    if (++arrived === 2) release(); await barrier;
    expect(currentLogContext()).toBe(before); expect(command.causationId).toBe(command.correlationId); return result;
  } }, new JsonLogger(line => lines.push(line)));
  await runWithLogContext({ correlationId: 'http-parent', transactionId: 'unrelated' }, () => Promise.all([
    handler.execute(envelope('message-a')), handler.execute(envelope('message-b')),
  ]));
  await flush(); expect(lines.map(line => JSON.parse(line).correlationId).sort()).toEqual(['message-a', 'message-b']);
  expect(lines.join('')).not.toContain('http-parent'); expect(lines.join('')).not.toContain('unrelated'); expect(currentLogContext()).toEqual({});
});
test('logger rejection cannot change real domain result, cause a retry or anticipate ACK before the committed handler result', async () => {
  const persistence = new HttpMemoryPersistence();
  const wallet = await new OpenWallet(persistence.walletOpening).execute({ playerId: 'player', initialBalance: { amount: '100.00', currency: 'BRL' }, correlationId: 'opening' });
  let release!: () => void; let started!: () => void; let acks = 0; let processing = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
  const processor = new ProcessWagerTransaction(persistence.wagerProcessing);
  const handler = new SqsWagerCommandHandler({ execute: async (command, inbox) => { processing++; started(); await barrier; return processor.execute(command, inbox); } },
    new JsonLogger(() => Promise.reject(new Error('LOG_SECRET'))));
  const delivery = new SqsWagerDelivery(handler, { send: async () => {
    acks++; expect(persistence.wallets.get(wallet.id)!.balance.toString()).toBe('75.00'); expect(persistence.ledger).toHaveLength(2); return { $metadata: {} };
  } }, config);
  const processingResult = delivery.execute({ sqsMessageId: 'TRANSPORT_SECRET', receiptHandle: 'RECEIPT_SECRET', messageGroupId: wallet.id,
    envelope: envelope('domain-message', wallet.id) as Parameters<typeof delivery.execute>[0]['envelope'] });
  await entered; expect(acks).toBe(0); expect(persistence.ledger).toHaveLength(1); release();
  expect(await processingResult).toMatchObject({ status: Status.Processed, balance: { amount: '75.00' }, idempotentReplay: false });
  await flush(); expect(acks).toBe(1); expect(processing).toBe(1);
  expect(persistence.events.slice(2).every(event => event.correlationId === 'domain-message' && event.causationId === 'domain-message')).toBe(true);
});
function outboxEvent(): ReservedOutboxEvent {
  return { id: 'event', aggregateId: 'wallet', eventType: 'WagerTransactionProcessed', eventVersion: 1,
    payload: { correlationId: 'original-correlation', causationId: 'CAUSATION_SECRET',
      data: { transactionId: 'transaction', providerId: 'provider', money: { amount: 'FINANCIAL_SECRET' }, playerId: 'PLAYER_SECRET' } },
    occurredAt: new Date('2026-11-19T10:00:00Z'), attempts: 1, nextAttemptAt: null, publishedAt: null, leaseToken: 'LEASE_SECRET', leaseUntil: new Date('2026-11-19T10:01:00Z') };
}
test('outbox logs preserve persisted correlation, omit causation/transport IDs and do not modify publication payload', async () => {
  const lines: string[] = []; const event = outboxEvent(); const original = structuredClone(event); let sent: unknown;
  const publisher = new SqsOutboxPublisher({ send: async command => {
    expect(currentLogContext().correlationId).toBe('original-correlation');
    sent = JSON.parse(command.input.MessageBody!);
    return { $metadata: { httpStatusCode: 200 }, MessageId: 'TRANSPORT_SECRET', SequenceNumber: '1',
      MD5OfMessageBody: createHash('md5').update(command.input.MessageBody!).digest('hex') };
  } }, 'http://localhost:4566/000000000000/wager-events.fifo', new JsonLogger(line => lines.push(line)));
  await runWithLogContext({ correlationId: 'unrelated', messageId: 'wrong-envelope' }, () => publisher.publish(event));
  await flush(); expect(event).toEqual(original); expect(sent).toMatchObject({ payload: event.payload });
  expect(lines.map(line => JSON.parse(line))).toEqual([expect.objectContaining({ correlationId: 'original-correlation', transactionId: 'transaction', walletId: 'wallet', providerId: 'provider', event: 'outbox.publication_confirmed' })]);
  expect(lines.join('')).not.toContain('SECRET'); expect(lines.join('')).not.toContain('messageId'); expect(lines.join('')).not.toContain('unrelated');
});
test('outbox sink failure cannot turn a confirmed send into publication retry', async () => {
  let sends = 0;
  const publisher = new SqsOutboxPublisher({ send: async command => { sends++; return { $metadata: { httpStatusCode: 200 },
    MessageId: 'transport', SequenceNumber: '1', MD5OfMessageBody: createHash('md5').update(command.input.MessageBody!).digest('hex') }; } },
  'http://localhost:4566/000000000000/wager-events.fifo', new JsonLogger(() => { throw new Error('LOG_SECRET'); }));
  expect((await publisher.publish(outboxEvent())).eventId).toBe('event'); await flush(); expect(sends).toBe(1);
});
