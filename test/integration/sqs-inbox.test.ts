import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { TransactionContext } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient, CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, ChangeMessageVisibilityCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { InboxMessageRecord } from '../../src/database/entities';
import { ProcessWagerTransaction } from '../../src/modules/wagering/application/process-wager-transaction';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import type { WagerProcessingUnitOfWork } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { WagerInboxConflictError } from '../../src/modules/wagering/application/wager-inbox';
import { WagerIdentityConflictError } from '../../src/modules/wagering/application/wager-transaction-identity';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { SqsWagerCommandHandler } from '../../src/modules/messaging/application/sqs-wager-command-handler';
import { JsonLogger } from '../../src/modules/operations/json-logger';
import { SqsWagerDelivery } from '../../src/modules/messaging/infrastructure/sqs-wager-delivery';
import { SqsWagerReceiver, type SqsWagerConfiguration, type ReceivedWagerRequest } from '../../src/modules/messaging/infrastructure/sqs-wager-receiver';
import { parseWagerTransactionRequested, type WagerTransactionRequested } from '../../src/modules/messaging/application/wager-requested';
import { wagerMessageIdentity } from '../../src/modules/messaging/application/wager-message-identity';
import { assertSqsTestEnvironment } from '../helpers/sqs-test-environment';
import { bounded } from '../helpers/bun-process-client';
import { testPersistence, openTestWallet, wagerCommand, walletPersistenceSnapshot, assertWalletLedger } from '../helpers/postgres-wager-fixtures';
import { withWagerFault } from '../helpers/wager-faults';
import { createHttpApplication } from '../../src/http/http-api.module';
import { PostgresWalletOpeningUnitOfWork } from '../../src/modules/wallets/infrastructure/postgres-wallet-opening-unit-of-work';
import { httpRequest } from '../helpers/http-request';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe.skipIf(!enabled)('Atomic inbox and post-commit SQS ACK (7.2, real PostgreSQL and MiniStack)', () => {
  let orm: MikroORM; let client: SQSClient;
  const work = () => new PostgresWagerProcessingUnitOfWork(orm);
  beforeAll(async () => {
    assertSqsTestEnvironment(process.env);
    const health = await fetch('http://ministack:4566/_ministack/health', { signal: AbortSignal.timeout(3000) });
    expect(health.ok).toBe(true); expect(await health.json()).toMatchObject({ version: '1.5.39', services: { sqs: 'available' } });
    orm = await testPersistence(); await orm.getMigrator().up();
    client = new SQSClient({ endpoint: 'http://ministack:4566', region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1, useQueueUrlAsEndpoint: false, requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 } });
  }, 30000);
  afterAll(async () => { client?.destroy(); if (orm) await orm.close(true); });
  async function withQueue(run: (config: SqsWagerConfiguration) => Promise<void>) {
    const name = `inbox-${randomUUID()}.fifo`;
    const created = await client.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }));
    expect(new URL(created.QueueUrl!).pathname).toBe(`/000000000000/${name}`);
    const config = { endpoint: 'http://ministack:4566', region: 'us-east-1', queueUrl: `http://ministack:4566/000000000000/${name}`, visibilityTimeout: 60, waitTimeSeconds: 1 };
    try { await run(config); } finally { await client.send(new DeleteQueueCommand({ QueueUrl: config.queueUrl })); }
  }
  const processor = (unit: WagerProcessingUnitOfWork = work()) => new ProcessWagerTransaction(unit);
  const runner = (config: SqsWagerConfiguration, unit: WagerProcessingUnitOfWork = work()) => new SqsWagerDelivery(new SqsWagerCommandHandler(processor(unit)), client, config);
  const event = (command: ReturnType<typeof wagerCommand>, messageId = randomUUID()) => {
    const { correlationId: _correlation, causationId: _causation, ...data } = command;
    return parseWagerTransactionRequested({ messageId, type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00Z', data });
  };
  async function send(config: SqsWagerConfiguration, envelope: WagerTransactionRequested, group = randomUUID()): Promise<ReceivedWagerRequest> {
    const sent = await client.send(new SendMessageCommand({ QueueUrl: config.queueUrl, MessageBody: JSON.stringify(envelope), MessageGroupId: group, MessageDeduplicationId: randomUUID() }));
    const received = await new SqsWagerReceiver(client, config).receiveOnce(); expect(received).toBeDefined();
    expect(sent.MessageId).toBeDefined(); expect(received!.sqsMessageId).toBe(sent.MessageId!); return received!;
  }
  async function inbox(envelope: WagerTransactionRequested) {
    const identity = wagerMessageIdentity(envelope);
    return orm.em.fork().findOne(InboxMessageRecord, { messageId: identity.messageId, consumerName: identity.consumerName });
  }
  async function receiveAgain(config: SqsWagerConfiguration, delivery: ReceivedWagerRequest) {
    await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: config.queueUrl, ReceiptHandle: delivery.receiptHandle, VisibilityTimeout: 0 }));
    const received = await new SqsWagerReceiver(client, config).receiveOnce(); expect(received).toBeDefined(); return received!;
  }
  async function expectLock(pid: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await orm.em.fork().execute<{ wait_event_type: string }[]>('SELECT wait_event_type FROM pg_stat_activity WHERE pid=?', [pid]);
      if (rows[0]?.wait_event_type === 'Lock') { expect(rows[0].wait_event_type).toBe('Lock'); return; }
      await Bun.sleep(10);
    }
    throw new Error('Contender did not wait for the PostgreSQL inbox/identity lock');
  }
  const backend = async () => {
    const manager = TransactionContext.getEntityManager()!;
    const [row] = await manager.getConnection().execute<{ pid: number }[]>('SELECT pg_backend_pid() AS pid', [], 'all', manager.getTransactionContext()); return row!.pid;
  };

  test('first delivery commits inbox, wallet, ledger and outbox before real deletion', async () => {
    await withQueue(async config => {
      const wallet = await openTestWallet(orm); const envelope = event(wagerCommand(wallet)); const delivered = await send(config, envelope);
      const realAck = { send: async (command: DeleteMessageCommand) => {
        const row = await inbox(envelope); expect(row!.processedAt).toBeInstanceOf(Date); await assertWalletLedger(orm, wallet, '75.00');
        return client.send(command);
      } };
      const result = await new SqsWagerDelivery(new SqsWagerCommandHandler(processor(), new JsonLogger(() => Promise.reject(new Error('LOG_SECRET')))), realAck, config).execute(delivered);
      expect(result.status).toBe(Status.Processed); expect((await inbox(envelope))!.payloadHash).toBe(wagerMessageIdentity(envelope).payloadHash);
      expect(await new SqsWagerReceiver(client, { ...config, waitTimeSeconds: 0 }).receiveOnce()).toBeUndefined();
    });
  });
  test('new transport message with the same envelope replays after restart without new effects', async () => {
    await withQueue(async config => {
      const wallet = await openTestWallet(orm); const envelope = event(wagerCommand(wallet));
      const first = await runner(config).execute(await send(config, envelope)); const before = await walletPersistenceSnapshot(orm, wallet); const row = await inbox(envelope);
      const secondOrm = await testPersistence();
      try {
        const restarted = new SqsWagerDelivery(new SqsWagerCommandHandler(new ProcessWagerTransaction(new PostgresWagerProcessingUnitOfWork(secondOrm))), client, config);
        expect(await restarted.execute(await send(config, envelope))).toEqual({ ...first, idempotentReplay: true });
      } finally { await secondOrm.close(true); }
      expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before); expect(await inbox(envelope)).toEqual(row);
    });
  });
  test.each(['amount', 'key', 'timestamp'] as const)('same envelope identity with changed %s conflicts and is not deleted', async field => {
    await withQueue(async config => {
      const wallet = await openTestWallet(orm); const envelope = event(wagerCommand(wallet)); await runner(config).execute(await send(config, envelope));
      const before = await walletPersistenceSnapshot(orm, wallet); const beforeInbox = await inbox(envelope);
      const changed = { ...envelope, ...(field === 'timestamp' ? { occurredAt: '2026-07-30T15:00:00Z' } : {}), data: { ...envelope.data,
        ...(field === 'amount' ? { money: { amount: '26.00', currency: 'BRL' } } : {}), ...(field === 'key' ? { idempotencyKey: randomUUID() } : {}) } };
      const delivered = await send(config, changed); await expect(runner(config).execute(delivered)).rejects.toBeInstanceOf(WagerInboxConflictError);
      expect((await receiveAgain(config, delivered)).envelope).toEqual(changed);
      expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before); expect(await inbox(envelope)).toEqual(beforeInbox);
    });
  });
  test('different envelope IDs have independent inbox rows but one financial identity', async () => {
    await withQueue(async config => {
      const wallet = await openTestWallet(orm); const first = event(wagerCommand(wallet)); const second = { ...first, messageId: randomUUID() };
      const result = await runner(config).execute(await send(config, first)); const before = await walletPersistenceSnapshot(orm, wallet);
      expect(await runner(config).execute(await send(config, second))).toEqual({ ...result, idempotentReplay: true });
      expect((await inbox(first))!.processedAt).toBeInstanceOf(Date); expect((await inbox(second))!.processedAt).toBeInstanceOf(Date);
      expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before);
    });
  });
  test('HTTP first then SQS records inbox and ACKs the historical replay without new financial effects', async () => {
    await withQueue(async config => {
      const wallet = await openTestWallet(orm); const command = wagerCommand(wallet); const envelope = event(command);
      const app = await createHttpApplication({ walletOpening: new PostgresWalletOpeningUnitOfWork(orm), wagerProcessing: work() }, { logger: false });
      try {
        await app.init(); const { correlationId: _context, idempotencyKey, ...body } = command;
        const first = await httpRequest(app, '/wagering/transactions', body, [['Idempotency-Key', idempotencyKey]]); expect(first.status).toBe(200);
        const before = await walletPersistenceSnapshot(orm, wallet);
        expect(await runner(config).execute(await send(config, envelope))).toMatchObject({ ...first.body as object, idempotentReplay: true });
        expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before); expect((await inbox(envelope))!.processedAt).toBeInstanceOf(Date);
      } finally { await app.close(); }
    });
  });
  test.each([Status.Rejected, Status.PendingReference])('%s is durably accepted and ACKed; replay preserves snapshot after later operations', async status => {
    await withQueue(async config => {
      const wallet = await openTestWallet(orm); const original = wagerCommand(wallet);
      const command = status === Status.Rejected ? { ...original, money: { amount: '101.00', currency: 'BRL' } }
        : { ...original, kind: Kind.Win as const, referenceExternalTransactionId: 'late-reference-' + wallet.id };
      const envelope = event(command); const first = await runner(config).execute(await send(config, envelope)); expect(first.status).toBe(status);
      if (status === Status.Rejected) expect(first.failureCode).toBe(FailureCode.InsufficientFunds);
      const accepted = await walletPersistenceSnapshot(orm, wallet); expect(accepted.wallet.balance).toBe('100.00'); expect(accepted.wallet.version).toBe(1); expect(accepted.ledger).toHaveLength(1);
      if (status === Status.PendingReference) await processor().execute(wagerCommand(wallet, Kind.Bet, { externalTransactionId: command.referenceExternalTransactionId! }));
      else await processor().execute(wagerCommand(wallet, Kind.Win, { money: { amount: '10.00', currency: 'BRL' } }));
      const before = await walletPersistenceSnapshot(orm, wallet); const beforeInbox = await inbox(envelope);
      expect(await runner(config).execute(await send(config, envelope))).toEqual({ ...first, idempotentReplay: true });
      expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before); expect(await inbox(envelope)).toEqual(beforeInbox);
    });
  });
  test.each(['identical', 'conflict', 'winner-rollback'] as const)('two deliveries contend on one inbox (%s), with no partial visibility or duplicate effect', async mode => {
    const conflict = mode === 'conflict'; const failWinner = mode === 'winner-rollback';
    await withQueue(async config => {
      const wallet = await openTestWallet(orm); const envelope = event(wagerCommand(wallet)); const before = await walletPersistenceSnapshot(orm, wallet);
      const one = await send(config, envelope); const two = await send(config, conflict ? { ...envelope, data: { ...envelope.data, money: { amount: '26.00', currency: 'BRL' } } } : envelope);
      const reached = latch(); const release = latch(); const entering = latch(); let contenderPid = 0;
      const holding: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(async scope => { const result = await callback(scope); reached.resolve(); await bounded(release.promise, 6000, 'winner release'); if (failWinner) throw new Error('Injected winner rollback'); return result; }) };
      const contender: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(async scope => { contenderPid = await backend(); entering.resolve(); return callback(scope); }) };
      const first = runner(config, holding).execute(one); void first.catch(() => {}); let second: ReturnType<SqsWagerDelivery['execute']> | undefined;
      try {
        await bounded(Promise.race([reached.promise, first.then(() => { throw new Error('Premature commit'); })]), 3000, 'winner callback');
        expect(await inbox(envelope)).toBeNull(); expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before);
        second = runner(config, contender).execute(two); void second.catch(() => {}); await bounded(entering.promise, 3000, 'contender entry');
        await expectLock(contenderPid); release.resolve();
        if (failWinner) {
          await expect(first).rejects.toThrow('Injected winner rollback'); expect((await second)!.idempotentReplay).toBe(false);
          const committed = await walletPersistenceSnapshot(orm, wallet);
          expect((await runner(config).execute(await receiveAgain(config, one))).idempotentReplay).toBe(true);
          expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(committed);
        } else {
          const result = await first;
          if (conflict) { await expect(second).rejects.toBeInstanceOf(WagerInboxConflictError); expect((await receiveAgain(config, two)).envelope.data.money.amount).toBe('26.00'); }
          else expect(await second).toEqual({ ...result, idempotentReplay: true });
        }
        await assertWalletLedger(orm, wallet, '75.00'); expect((await inbox(envelope))!.processedAt).toBeInstanceOf(Date);
      } finally { release.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
    });
  }, 15000);
  test.each(['first-event', 'before-commit'] as const)('failure %s rolls back inbox and all financial rows; redelivery can commit once', async point => {
    await withQueue(async config => {
      const wallet = await openTestWallet(orm); const envelope = event(wagerCommand(wallet)); const delivered = await send(config, envelope);
      const before = await walletPersistenceSnapshot(orm, wallet);
      await expect(runner(config, withWagerFault(work(), point)).execute(delivered)).rejects.toThrow('Injected fault');
      expect(await inbox(envelope)).toBeNull(); expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before);
      expect((await runner(config).execute(await receiveAgain(config, delivered))).idempotentReplay).toBe(false); await assertWalletLedger(orm, wallet, '75.00');
    });
  });
  test('deferred SQL commit failure rolls back even completed inbox and sends no deletion', async () => {
    await withQueue(async config => {
      const wallet = await openTestWallet(orm); const envelope = event(wagerCommand(wallet)); const delivered = await send(config, envelope); const before = await walletPersistenceSnapshot(orm, wallet);
      let callbackCompleted = false;
      const broken: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(async scope => {
        const result = await callback({ ...scope, insertLedgerEntry: async () => {} }); callbackCompleted = true; return result;
      }) };
      await expect(runner(config, broken).execute(delivered)).rejects.toMatchObject({ code: '23514' }); expect(callbackCompleted).toBe(true);
      expect(await inbox(envelope)).toBeNull(); expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before);
      await runner(config).execute(await receiveAgain(config, delivered)); await assertWalletLedger(orm, wallet, '75.00');
    });
  });
  test('ACK failure after real commit allows actual SQS redelivery with no duplicate financial effect', async () => {
    await withQueue(async config => {
      const wallet = await openTestWallet(orm); const envelope = event(wagerCommand(wallet)); const delivered = await send(config, envelope);
      const failure = new Error('Injected ACK network failure');
      const failedAck = { send: async (_command: DeleteMessageCommand): Promise<never> => { throw failure; } };
      await expect(new SqsWagerDelivery(new SqsWagerCommandHandler(processor()), failedAck, config).execute(delivered)).rejects.toBe(failure);
      const before = await walletPersistenceSnapshot(orm, wallet); const beforeInbox = await inbox(envelope); expect(beforeInbox!.processedAt).toBeInstanceOf(Date);
      const next = await receiveAgain(config, delivered); expect((await runner(config).execute(next)).idempotentReplay).toBe(true);
      expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before); expect(await inbox(envelope)).toEqual(beforeInbox);
      expect(await new SqsWagerReceiver(client, { ...config, waitTimeSeconds: 0 }).receiveOnce()).toBeUndefined();
    });
  });
  test('cross-wallet financial UNIQUE collision rolls back inbox before identity recovery and never ACKs the loser', async () => {
    await withQueue(async config => {
      const one = await openTestWallet(orm); const two = await openTestWallet(orm); const command = wagerCommand(one);
      const winner = event(command); const loser = event({ ...command, walletId: two.id, playerId: two.playerId });
      const winnerDelivery = await send(config, winner); const loserDelivery = await send(config, loser); const before = await walletPersistenceSnapshot(orm, two);
      const reached = latch(); const release = latch(); const entering = latch(); let loserPid = 0;
      const held: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(async scope => { const result = await callback(scope); reached.resolve(); await bounded(release.promise, 6000, 'unique winner release'); return result; }) };
      const observed: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(async scope => {
        loserPid = await backend(); return callback({ ...scope, insertPending: async value => { entering.resolve(); await scope.insertPending(value); } });
      }) };
      const first = runner(config, held).execute(winnerDelivery); void first.catch(() => {}); let second: ReturnType<SqsWagerDelivery['execute']> | undefined;
      try {
        await bounded(Promise.race([reached.promise, first.then(() => { throw new Error('Premature commit'); })]), 3000, 'unique winner callback');
        second = runner(config, observed).execute(loserDelivery); void second.catch(() => {}); await bounded(entering.promise, 3000, 'unique contender insert');
        await expectLock(loserPid); release.resolve(); await first; await expect(second).rejects.toBeInstanceOf(WagerIdentityConflictError);
        expect(await inbox(loser)).toBeNull(); expect(await walletPersistenceSnapshot(orm, two)).toEqual(before); expect((await receiveAgain(config, loserDelivery)).envelope).toEqual(loser);
        await assertWalletLedger(orm, one, '75.00'); await assertWalletLedger(orm, two, '100.00');
      } finally { release.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
    });
  }, 15000);
});
