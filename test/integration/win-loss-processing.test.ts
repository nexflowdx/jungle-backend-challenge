import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { TransactionContext, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createPersistence } from '../../src/database/orm';
import { WalletRecord, WagerTransactionRecord, LedgerEntryRecord, OutboxMessageRecord } from '../../src/database/entities';
import { rehydrateMoney } from '../../src/database/money-mapping';
import { OpenWallet } from '../../src/modules/wallets/application/open-wallet';
import { PostgresWalletOpeningUnitOfWork } from '../../src/modules/wallets/infrastructure/postgres-wallet-opening-unit-of-work';
import { ProcessWagerTransaction, WagerProcessingNotImplementedError, WagerResultUnavailableError, type SupportedWagerCommand } from '../../src/modules/wagering/application/process-wager-transaction';
import type { WagerProcessingUnitOfWork } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { WagerTransactionIdentity, WagerIdentityCollisionError } from '../../src/modules/wagering/application/wager-transaction-identity';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { assertPersistenceTestEnvironment } from './environment';
import { assertHistoricalReplay } from './historical-replay';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
type Target = { id: string; playerId: string; balance: { amount: string; currency: string } };
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(!enabled)('Atomic WIN and LOSS PostgreSQL integration (5.4)', () => {
  let orm: MikroORM;
  const connection = () => ({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test', user: 'diagnostic', password: process.env.PGPASSWORD! });
  const fresh = () => orm.em.fork();
  const work = () => new PostgresWagerProcessingUnitOfWork(orm);
  const processor = (scope: WagerProcessingUnitOfWork = work()) => new ProcessWagerTransaction(scope);
  const open = (amount = '100.00', currency = 'BRL') => new OpenWallet(new PostgresWalletOpeningUnitOfWork(orm))
    .execute({ playerId: randomUUID(), initialBalance: { amount, currency }, correlationId: randomUUID() });
  const command = (target: Target, kind: Kind.Win | Kind.Loss, overrides: Partial<SupportedWagerCommand> = {}): SupportedWagerCommand => ({
    walletId: target.id, playerId: target.playerId, kind, idempotencyKey: randomUUID(), providerId: 'provider',
    externalTransactionId: randomUUID(), gameId: 'game', roundId: 'round', money: { amount: '25.00', currency: target.balance.currency },
    correlationId: randomUUID(), ...overrides,
  });
  async function events(target: Target, id: string) {
    return (await fresh().find(OutboxMessageRecord, { aggregateId: target.id }))
      .filter(event => (event.payload.data as { transactionId: string }).transactionId === id);
  }
  async function consistent(target: Target, expected: string) {
    const [row] = await fresh().execute<{ balance: string; reconstructed: string }[]>(`SELECT w.balance,
      COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0) AS reconstructed
      FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id=w.id WHERE w.id=? GROUP BY w.id`, [target.id]);
    expect(row!.balance).toBe(expected);
    expect(rehydrateMoney(row!.balance, target.balance.currency).equals(rehydrateMoney(row!.reconstructed, target.balance.currency))).toBe(true);
    for (const tx of await fresh().find(WagerTransactionRecord, { walletId: target.id, kind: { $in: [Kind.Win, Kind.Loss] } })) {
      expect(tx.status === Status.Processed || tx.status === Status.Rejected).toBe(true);
      const movement = tx.kind === Kind.Win && tx.status === Status.Processed;
      const entries = await fresh().find(LedgerEntryRecord, { transactionId: tx.id });
      expect(entries).toHaveLength(movement ? 1 : 0);
      if (entries[0]) expect(entries[0]).toMatchObject({ direction: 'CREDIT', amount: tx.amount, balanceAfter: tx.balance });
      const outbox = await events(target, tx.id);
      expect(outbox.map(event => event.eventType).sort()).toEqual((tx.status === Status.Rejected ? ['WagerTransactionRejected']
        : movement ? ['WagerTransactionProcessed', 'WalletBalanceChanged'] : ['WagerTransactionProcessed']).sort());
      for (const event of outbox) expect(event.publishedAt).toBeNull();
    }
  }
  async function unchanged(target: Target) {
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id, kind: { $in: [Kind.Win, Kind.Loss] } })).toBe(0);
    expect(await fresh().count(LedgerEntryRecord, { walletId: target.id })).toBe(target.balance.amount === '0.00' ? 0 : 1);
    expect(await fresh().count(OutboxMessageRecord, { aggregateId: target.id })).toBe(target.balance.amount === '0.00' ? 0 : 2);
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).version).toBe(1);
    await consistent(target, target.balance.amount);
  }
  function failAfter(point: string): WagerProcessingUnitOfWork {
    const fail = (name: string) => { if (point === name) throw new Error(`Injected ${point}`); };
    return { transaction: callback => work().transaction(async scope => {
      const result = await callback({ ...scope,
        insertPending: async tx => { await scope.insertPending(tx); fail('pending'); },
        saveWallet: async wallet => { await scope.saveWallet(wallet); fail('wallet'); },
        completeTransaction: async tx => { await scope.completeTransaction(tx); fail('result'); },
        insertLedgerEntry: async entry => { await scope.insertLedgerEntry(entry); fail('ledger'); },
        insertEvents: async items => { await scope.insertEvents(items); fail('outbox'); },
      });
      fail('commit'); return result;
    }) };
  }
  async function waitForLock(pid: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [row] = await fresh().execute<{ wait_event_type: string | null }[]>('SELECT wait_event_type FROM pg_stat_activity WHERE pid=?', [pid]);
      if (row?.wait_event_type === 'Lock') return;
      await Bun.sleep(10);
    }
    throw new Error('Expected the LOSS to wait for the WIN wallet lock');
  }
  beforeAll(async () => {
    assertPersistenceTestEnvironment(process.env); orm = await createPersistence(connection()); await orm.getMigrator().up();
  }, 30000);
  afterAll(async () => { if (orm) await orm.close(true); });

  test.each([
    ['0.00', '0.01', '0.01', 'BRL'], ['100.00', '25.00', '125.00', 'BRL'], ['100.00', '25.00', '125.00', 'USD'],
    ['9007199254740993.00', '0.01', '9007199254740993.01', 'USD'], ['0.00', '92233720368547758.07', '92233720368547758.07', 'BRL'],
    ['92233720368547758.06', '0.01', '92233720368547758.07', 'USD'],
  ])('WIN %s plus %s yields exact %s %s', async (initial, amount, expected, currency) => {
    const target = await open(initial!, currency!); const input = command(target, Kind.Win, { money: { amount: amount!, currency: currency! } });
    const result = await processor().execute(input);
    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: expected, currency }, idempotentReplay: false });
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).version).toBe(2);
    for (const event of await events(target, result.transactionId)) expect(event.payload.correlationId).toBe(input.correlationId);
    await consistent(target, expected!);
  });
  test.each([['0.00', '0.00', 'BRL'], ['100.00', '0.00', 'USD'], ['100.00', '25.00', 'BRL'], ['100.00', '25.00', 'USD']])(
    'LOSS at balance %s with amount %s %s never writes wallet or ledger', async (initial, amount, currency) => {
      const target = await open(initial!, currency!); const before = await fresh().findOneOrFail(WalletRecord, target.id);
      const guarded: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(scope => callback({ ...scope,
        saveWallet: async () => { throw new Error('LOSS attempted a wallet write'); },
        insertLedgerEntry: async () => { throw new Error('LOSS attempted a ledger write'); },
      })) };
      const result = await processor(guarded).execute(command(target, Kind.Loss, { money: { amount: amount!, currency: currency! } }));
      expect(result).toMatchObject({ status: Status.Processed, balance: { amount: initial, currency } });
      const after = await fresh().findOneOrFail(WalletRecord, target.id);
      expect(after.version).toBe(before.version); expect(after.updatedAt).toEqual(before.updatedAt);
      await consistent(target, initial!);
    },
  );
  test('WIN overflow rejects without changing balance, version or ledger', async () => {
    const target = await open('92233720368547758.07');
    expect(await processor().execute(command(target, Kind.Win, { money: { amount: '0.01', currency: 'BRL' } })))
      .toMatchObject({ status: Status.Rejected, failureCode: FailureCode.AmountLimitExceeded });
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).version).toBe(1);
    await consistent(target, target.balance.amount);
  });
  test.each([Kind.Win, Kind.Loss])('%s rejects currency mismatch without movement', async kind => {
    const target = await open();
    expect(await processor().execute(command(target, kind, { money: { amount: '1.00', currency: 'USD' } })))
      .toMatchObject({ status: Status.Rejected, failureCode: FailureCode.CurrencyMismatch, balance: { amount: '100.00', currency: 'BRL' } });
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).version).toBe(1);
    await consistent(target, '100.00');
  });
  test.each([Kind.Win, Kind.Loss])('%s replays the processed snapshot after BET and client restart', async kind => {
    const target = await open(); const input = command(target, kind); const first = await processor().execute(input);
    await processor().execute({ ...command(target, Kind.Win), kind: Kind.Bet, money: { amount: '10.00', currency: 'BRL' } });
    await assertHistoricalReplay(orm, input, first);
    await consistent(target, kind === Kind.Win ? '115.00' : '90.00');
  });
  test.each([Kind.Win, Kind.Loss])('%s replays its original rejection after a later BET and application restart', async kind => {
    const target = await open(kind === Kind.Win ? '92233720368547758.07' : '100.00');
    const input = command(target, kind, { money: { amount: '0.01', currency: kind === Kind.Win ? 'BRL' : 'USD' } });
    const first = await processor().execute(input); expect(first.status).toBe(Status.Rejected);
    await processor().execute({ ...command(target, Kind.Win), kind: Kind.Bet, money: { amount: '0.01', currency: 'BRL' } });
    await assertHistoricalReplay(orm, input, first);
    await consistent(target, kind === Kind.Win ? '92233720368547758.06' : '99.99');
  });
  test.each([Kind.Win, Kind.Loss])('ten concurrent repetitions of %s have one effect and one event set', async kind => {
    const target = await open(); const input = command(target, kind);
    const results = await Promise.all(Array.from({ length: 10 }, () => processor().execute({ ...input, correlationId: randomUUID() })));
    expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
    expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id, kind })).toBe(1);
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).version).toBe(kind === Kind.Win ? 2 : 1);
    await consistent(target, kind === Kind.Win ? '125.00' : '100.00');
  });
  test('distinct concurrent WINs accumulate exact credits under the wallet lock', async () => {
    const target = await open();
    await Promise.all(Array.from({ length: 10 }, () => processor().execute(command(target, Kind.Win, { money: { amount: '10.00', currency: 'BRL' } }))));
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).version).toBe(11);
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id, kind: Kind.Win })).toBe(10);
    await consistent(target, '200.00');
  });
  test('an unrelated wallet progresses while another wallet is locked', async () => {
    const blocked = await open(); const target = await open(); const acquired = latch(); const release = latch();
    const holding = work().transaction(async scope => { await scope.lockWallet(blocked.id); acquired.resolve(); await release.promise; });
    void holding.catch(() => {});
    let running: ReturnType<ProcessWagerTransaction['execute']> | undefined;
    try {
      await Promise.race([acquired.promise, holding.then(() => { throw new Error('Premature unlock'); })]);
      running = processor().execute(command(target, Kind.Win));
      expect((await Promise.race([running, Bun.sleep(3000).then(() => { throw new Error('Global wallet lock'); })])).status).toBe(Status.Processed);
    } finally { release.resolve(); await Promise.allSettled(running ? [holding, running] : [holding]); }
    await unchanged(blocked); await consistent(target, '125.00');
  });
  test.each([Kind.Win, Kind.Loss])('%s conflicts on changed payload or kind without additional effects', async kind => {
    const target = await open(); const input = command(target, kind); await processor().execute(input);
    await expect(processor().execute({ ...input, money: { amount: '26.00', currency: 'BRL' } })).rejects.toMatchObject({ reason: 'PAYLOAD_MISMATCH' });
    await expect(processor().execute({ ...input, kind: kind === Kind.Win ? Kind.Loss : Kind.Win })).rejects.toMatchObject({ reason: 'PAYLOAD_MISMATCH' });
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id, kind })).toBe(1);
    await consistent(target, kind === Kind.Win ? '125.00' : '100.00');
  });
  test.each(['pending', 'wallet', 'result', 'ledger', 'outbox', 'commit'])('WIN failure after %s rolls back every financial artifact', async point => {
    const target = await open(); const input = command(target, Kind.Win);
    await expect(processor(failAfter(point)).execute(input)).rejects.toThrow(`Injected ${point}`);
    await unchanged(target);
    expect((await processor().execute(input)).idempotentReplay).toBe(false); await consistent(target, '125.00');
  });
  test.each(['pending', 'result', 'outbox', 'commit'])('LOSS failure after %s rolls back the result and outbox', async point => {
    const target = await open(); const input = command(target, Kind.Loss);
    await expect(processor(failAfter(point)).execute(input)).rejects.toThrow(`Injected ${point}`);
    await unchanged(target);
    expect((await processor().execute(input)).idempotentReplay).toBe(false); await consistent(target, '100.00');
  });
  test.each([Kind.Bet, Kind.Loss])('%s reference stays explicitly unavailable without a PENDING_REFERENCE result', async kind => {
    const target = await open();
    await expect(processor().execute({ ...command(target, Kind.Win, { referenceExternalTransactionId: 'reference' }), kind })).rejects.toBeInstanceOf(WagerProcessingNotImplementedError);
    await unchanged(target);
  });
  test.each([Kind.Win, Kind.Loss])('%s PENDING fixture cannot be returned as a completed result', async kind => {
    const target = await open(); const input = command(target, kind);
    const pending = new WagerTransactionIdentity().createCandidate(input, randomUUID(), new Date());
    await work().transaction(scope => scope.insertPending(pending));
    await expect(processor().execute(input)).rejects.toBeInstanceOf(WagerResultUnavailableError);
    expect((await fresh().findOneOrFail(WagerTransactionRecord, pending.id)).status).toBe(Status.Pending);
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).balance).toBe('100.00');
    expect(await fresh().count(LedgerEntryRecord, { transactionId: pending.id })).toBe(0);
    expect(await events(target, pending.id)).toHaveLength(0);
  });
  test.each([Kind.Win, Kind.Loss])('%s real outbox constraint failure rolls back and is not an identity conflict', async kind => {
    const target = await open(); const previous = await fresh().findOneOrFail(OutboxMessageRecord, { aggregateId: target.id });
    const ids = [randomUUID(), randomUUID(), previous.id, randomUUID()];
    const useCase = new ProcessWagerTransaction(work(), new WagerTransactionIdentity(), { newId: () => ids.shift()!, now: () => new Date(), retryDelay: async () => {} });
    let failure: unknown;
    try { await useCase.execute(command(target, kind)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(UniqueConstraintViolationException);
    expect(failure).not.toBeInstanceOf(WagerIdentityCollisionError); await unchanged(target);
  });
  test('WIN missing its ledger fails at commit and rolls back the callback result and all writes', async () => {
    const target = await open(); let completed = false;
    const incomplete: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(async scope => {
      const result = await callback({ ...scope, insertLedgerEntry: async () => {} }); completed = true; return result;
    }) };
    await expect(processor(incomplete).execute(command(target, Kind.Win))).rejects.toMatchObject({ code: '23514' });
    expect(completed).toBe(true); await unchanged(target);
  });
  test('LOSS observes the committed WIN balance after waiting on the same wallet lock', async () => {
    const target = await open(); const acquired = latch(); const release = latch(); const started = latch(); let backend = 0;
    const held: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(scope => callback({ ...scope,
      lockWallet: async id => { const wallet = await scope.lockWallet(id); acquired.resolve(); await release.promise; return wallet; },
    })) };
    const observed: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(scope => callback({ ...scope,
      lockWallet: async id => {
        const manager = TransactionContext.getEntityManager()!;
        const rows = await manager.getConnection().execute('SELECT pg_backend_pid() AS pid', [], 'all', manager.getTransactionContext());
        backend = rows[0].pid as number; started.resolve(); return scope.lockWallet(id);
      },
    })) };
    const win = processor(held).execute(command(target, Kind.Win)); void win.catch(() => {});
    let loss: ReturnType<ProcessWagerTransaction['execute']> | undefined;
    try {
      await Promise.race([acquired.promise, win.then(() => { throw new Error('Premature WIN result'); })]);
      loss = processor(observed).execute(command(target, Kind.Loss)); void loss.catch(() => {});
      await Promise.race([started.promise, loss.then(() => { throw new Error('Premature LOSS result'); })]);
      await waitForLock(backend); release.resolve();
      const results = await Promise.all([win, loss]);
      expect(results[0]!.balance.amount).toBe('125.00'); expect(results[1]!.balance.amount).toBe('125.00');
    } finally { release.resolve(); await Promise.allSettled(loss ? [win, loss] : [win]); }
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).version).toBe(2); await consistent(target, '125.00');
  });
});
