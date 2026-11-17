import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { TransactionContext, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WalletRecord, WagerTransactionRecord, LedgerEntryRecord, OutboxMessageRecord } from '../../src/database/entities';
import { createPersistence } from '../../src/database/orm';
import { walletMapper } from '../../src/database/domain-mappers';
import { rehydrateMoney } from '../../src/database/money-mapping';
import { OpenWallet } from '../../src/modules/wallets/application/open-wallet';
import { PostgresWalletOpeningUnitOfWork } from '../../src/modules/wallets/infrastructure/postgres-wallet-opening-unit-of-work';
import { ProcessWagerTransaction, WagerResultUnavailableError, type BetCommand } from '../../src/modules/wagering/application/process-wager-transaction';
import type { WagerProcessingUnitOfWork, WagerProcessingTransaction } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { WagerTransactionIdentity, WagerIdentityCollisionError } from '../../src/modules/wagering/application/wager-transaction-identity';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { assertPersistenceTestEnvironment } from './environment';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
type Target = { id: string; playerId: string; balance: { amount: string; currency: string } };
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(!enabled)('Atomic BET PostgreSQL integration (5.3)', () => {
  let orm: MikroORM;
  const fresh = () => orm.em.fork();
  const work = () => new PostgresWagerProcessingUnitOfWork(orm);
  const process = (scope: WagerProcessingUnitOfWork = work()) => new ProcessWagerTransaction(scope);
  const open = (amount = '100.00', currency = 'BRL') => new OpenWallet(new PostgresWalletOpeningUnitOfWork(orm))
    .execute({ playerId: randomUUID(), initialBalance: { amount, currency }, correlationId: randomUUID() });
  const command = (target: Target, overrides: Partial<BetCommand> = {}): BetCommand => ({
    walletId: target.id, playerId: target.playerId, providerId: 'provider', externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(), roundId: 'round', gameId: 'game', kind: Kind.Bet,
    money: { amount: '25.00', currency: target.balance.currency }, correlationId: randomUUID(), ...overrides,
  });
  async function consistent(target: Target, expected: string): Promise<void> {
    const [row] = await fresh().execute<{ balance: string; reconstructed: string }[]>(`SELECT w.balance,
      COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0) AS reconstructed
      FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id=w.id WHERE w.id=? GROUP BY w.id`, [target.id]);
    expect(row!.balance).toBe(expected);
    expect(rehydrateMoney(row!.balance, target.balance.currency).equals(rehydrateMoney(row!.reconstructed, target.balance.currency))).toBe(true);
    const bets = await fresh().find(WagerTransactionRecord, { walletId: target.id, kind: Kind.Bet });
    for (const bet of bets) {
      const entries = await fresh().find(LedgerEntryRecord, { transactionId: bet.id });
      expect(bet.status === Status.Processed || bet.status === Status.Rejected).toBe(true);
      expect(bet.completedAt).not.toBeNull();
      expect(entries).toHaveLength(bet.status === Status.Processed ? 1 : 0);
      if (entries[0]) expect(entries[0]).toMatchObject({ direction: 'DEBIT', amount: bet.amount, balanceAfter: bet.balance });
    }
  }
  async function betEvents(target: Target, transactionId: string) {
    return (await fresh().find(OutboxMessageRecord, { aggregateId: target.id }))
      .filter(event => (event.payload.data as { transactionId: string }).transactionId === transactionId);
  }
  async function noBet(target: Target): Promise<void> {
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id, kind: Kind.Bet })).toBe(0);
    expect(await fresh().count(LedgerEntryRecord, { walletId: target.id })).toBe(target.balance.amount === '0.00' ? 0 : 1);
    expect(await fresh().count(OutboxMessageRecord, { aggregateId: target.id })).toBe(target.balance.amount === '0.00' ? 0 : 2);
    await consistent(target, target.balance.amount);
  }
  function failAfter(delegate: WagerProcessingUnitOfWork, point: string): WagerProcessingUnitOfWork {
    const fail = (current: string) => { if (current === point) throw new Error(`BET failure: ${point}`); };
    return { transaction: callback => delegate.transaction(async scope => {
      const wrapped: WagerProcessingTransaction = {
        ...scope,
        insertPending: async tx => { await scope.insertPending(tx); fail('pending'); },
        saveWallet: async wallet => { await scope.saveWallet(wallet); fail('wallet'); },
        completeTransaction: async tx => { await scope.completeTransaction(tx); fail('result'); },
        insertLedgerEntry: async entry => { await scope.insertLedgerEntry(entry); fail('ledger'); },
        insertEvents: async events => { await scope.insertEvents(events); fail('outbox'); },
      };
      const result = await callback(wrapped); fail('commit'); return result;
    }) };
  }
  async function pid(): Promise<number> {
    const manager = TransactionContext.getEntityManager()!;
    const rows = await manager.getConnection().execute('SELECT pg_backend_pid() AS pid', [], 'all', manager.getTransactionContext());
    return rows[0].pid as number;
  }
  async function waitForLock(backend: number): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [row] = await fresh().execute<{ wait_event_type: string | null }[]>(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid=?', [backend]);
      if (row?.wait_event_type === 'Lock') return;
      await Bun.sleep(10);
    }
    throw new Error('BET contender did not wait for the wallet lock');
  }
  async function contend(first: BetCommand, second: BetCommand) {
    const acquired = latch(); const release = latch(); const started = latch(); let secondPid = 0;
    const held: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(scope => callback({ ...scope,
      lockWallet: async id => { const wallet = await scope.lockWallet(id); acquired.resolve(); await release.promise; return wallet; },
    })) };
    const observed: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(scope => callback({ ...scope,
      lockWallet: async id => { secondPid = await pid(); started.resolve(); return scope.lockWallet(id); },
    })) };
    const a = process(held).execute(first); void a.catch(() => {});
    let b: ReturnType<ProcessWagerTransaction['execute']> | undefined;
    try {
      await Promise.race([acquired.promise, a.then(() => { throw new Error('Premature result'); })]);
      b = process(observed).execute(second); void b.catch(() => {});
      await Promise.race([started.promise, b.then(() => { throw new Error('Premature contender result'); })]);
      await waitForLock(secondPid); release.resolve();
      return await Promise.allSettled([a, b]);
    } finally { release.resolve(); await Promise.allSettled(b ? [a, b] : [a]); }
  }

  beforeAll(async () => {
    assertPersistenceTestEnvironment(globalThis.process.env);
    orm = await createPersistence({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test',
      user: 'diagnostic', password: globalThis.process.env.PGPASSWORD! });
    await orm.getMigrator().up();
  }, 30000);
  afterAll(async () => { if (orm) await orm.close(true); });

  test.each([
    ['100.00', '25.00', '75.00', 'BRL'], ['100.00', '25.00', '75.00', 'USD'],
    ['0.01', '0.01', '0.00', 'BRL'], ['9007199254740993.01', '0.01', '9007199254740993.00', 'USD'],
    ['92233720368547758.07', '0.01', '92233720368547758.06', 'BRL'],
  ])('BET on %s debits %s exactly to %s %s', async (initial, amount, expected, currency) => {
    const target = await open(initial!, currency!); const input = command(target, { money: { amount: amount!, currency: currency! } });
    const result = await process().execute(input);
    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: expected, currency }, idempotentReplay: false });
    const record = await fresh().findOneOrFail(WagerTransactionRecord, result.transactionId);
    expect(record.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).version).toBe(2);
    const events = await betEvents(target, result.transactionId);
    expect(events.map(event => event.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged'].sort());
    for (const event of events) { expect(event.publishedAt).toBeNull(); expect(event.payload.correlationId).toBe(input.correlationId); }
    await consistent(target, expected!);
  });

  test.each(['0.00', '100.00'])('insufficient funds at %s reject with unchanged balance and ledger', async initial => {
    const target = await open(initial);
    const result = await process().execute(command(target, { money: { amount: '100.01', currency: 'BRL' } }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.InsufficientFunds, balance: { amount: initial } });
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).version).toBe(1);
    expect((await betEvents(target, result.transactionId)).map(event => event.eventType)).toEqual(['WagerTransactionRejected']);
    await consistent(target, initial);
  });
  test('two 80.00 BETs concurrently compete for 100.00 under an observed row lock', async () => {
    const target = await open();
    const results = await contend(command(target, { money: { amount: '80.00', currency: 'BRL' } }), command(target, { money: { amount: '80.00', currency: 'BRL' } }));
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: Status.Processed, balance: { amount: '20.00' } } });
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: { status: Status.Rejected, failureCode: FailureCode.InsufficientFunds, balance: { amount: '20.00' } } });
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id, kind: Kind.Bet })).toBe(2);
    expect(await fresh().count(LedgerEntryRecord, { walletId: target.id })).toBe(2);
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).version).toBe(2);
    await consistent(target, '20.00');
  });
  test('ten simultaneous repetitions yield one debit and no repeated events', async () => {
    const target = await open(); const input = command(target);
    const results = await Promise.all(Array.from({ length: 10 }, () => process().execute({ ...input, correlationId: randomUUID() })));
    expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
    expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id, kind: Kind.Bet })).toBe(1);
    expect(await betEvents(target, results[0]!.transactionId)).toHaveLength(2);
    await consistent(target, '75.00');
  });
  test('concurrent same-key payload changes conflict after the first BET commits', async () => {
    const target = await open(); const input = command(target);
    const results = await contend(input, { ...input, money: { amount: '30.00', currency: 'BRL' } });
    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'WAGER_IDENTITY_CONFLICT', reason: 'PAYLOAD_MISMATCH' } });
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id, kind: Kind.Bet })).toBe(1);
    await consistent(target, '75.00');
  });
  test('same provider/external ID under another key conflicts without another debit', async () => {
    const target = await open(); const input = command(target); await process().execute(input);
    await expect(process().execute({ ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ reason: 'EXTERNAL_ID_REUSED' });
    await consistent(target, '75.00');
  });
  test.each(['processed', 'rejected'])('replays a %s snapshot after later wallet changes and client restart', async status => {
    const target = await open(); const input = command(target, { money: { amount: status === 'processed' ? '25.00' : '101.00', currency: 'BRL' } });
    const first = await process().execute(input); await process().execute(command(target, { money: { amount: '10.00', currency: 'BRL' } }));
    const restarted = await createPersistence({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test', user: 'diagnostic', password: globalThis.process.env.PGPASSWORD! });
    try { expect(await new ProcessWagerTransaction(new PostgresWagerProcessingUnitOfWork(restarted)).execute(input)).toEqual({ ...first, idempotentReplay: true }); }
    finally { await restarted.close(true); }
    expect(await betEvents(target, first.transactionId)).toHaveLength(status === 'processed' ? 2 : 1);
    await consistent(target, status === 'processed' ? '65.00' : '90.00');
  });
  test.each(['pending', 'wallet', 'result', 'ledger', 'outbox', 'commit'])('failure after %s rolls back wallet, identity, result, ledger and outbox', async point => {
    const target = await open(); const input = command(target);
    await expect(process(failAfter(work(), point)).execute(input)).rejects.toThrow(`BET failure: ${point}`);
    await noBet(target);
    const retry = await process().execute(input); expect(retry.idempotentReplay).toBe(false);
    await consistent(target, '75.00');
  });
  test.each(['result', 'outbox'])('failure after rejected %s rolls back the rejection and its event', async point => {
    const target = await open();
    await expect(process(failAfter(work(), point)).execute(command(target, { money: { amount: '101.00', currency: 'BRL' } }))).rejects.toThrow('BET failure');
    await noBet(target);
  });
  test('a deferred integrity error at commit rolls back the BET even after its callback completed', async () => {
    const target = await open(); let completed = false;
    const incomplete: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(async scope => {
      const result = await callback({ ...scope, insertLedgerEntry: async () => {} });
      completed = true;
      return result;
    }) };
    await expect(process(incomplete).execute(command(target))).rejects.toMatchObject({ code: '23514' });
    expect(completed).toBe(true);
    await noBet(target);
  });
  test('locking one wallet does not block a BET on another wallet', async () => {
    const first = await open(); const other = await open(); const acquired = latch(); const release = latch();
    const holding = work().transaction(async scope => { await scope.lockWallet(first.id); acquired.resolve(); await release.promise; });
    void holding.catch(() => {});
    try {
      await Promise.race([acquired.promise, holding.then(() => { throw new Error('Premature unlock'); })]);
      const result = await Promise.race([process().execute(command(other)), Bun.sleep(3000).then(() => { throw new Error('Unrelated wallet was blocked'); })]);
      expect(result.status).toBe(Status.Processed);
    } finally { release.resolve(); await holding; }
    await noBet(first); await consistent(other, '75.00');
  });
  test('wallet lock timeout propagates without an identity reservation or financial effect', async () => {
    const target = await open(); const acquired = latch(); const release = latch();
    const holding = work().transaction(async scope => { await scope.lockWallet(target.id); acquired.resolve(); await release.promise; });
    void holding.catch(() => {});
    const limited: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(async scope => {
      const manager = TransactionContext.getEntityManager()!;
      await manager.getConnection().execute("SET LOCAL lock_timeout='250ms'", [], 'all', manager.getTransactionContext());
      return callback(scope);
    }) };
    try {
      await Promise.race([acquired.promise, holding.then(() => { throw new Error('Premature unlock'); })]);
      await expect(process(limited).execute(command(target))).rejects.toMatchObject({ code: '55P03' });
    } finally { release.resolve(); await holding; }
    await noBet(target);
  });
  test.each(['wallet', 'result'])('adapter forbids %s writes without locking the wallet', async point => {
    const target = await open();
    const wallet = await fresh().findOneOrFail(WalletRecord, target.id);
    const tx = new WagerTransactionIdentity().createCandidate(command(target), randomUUID(), new Date());
    await expect(work().transaction(async scope => {
      if (point === 'wallet') {
        await scope.saveWallet(walletMapper.toDomain(wallet));
      } else await scope.completeTransaction(tx);
    })).rejects.toThrow('locked wallet');
    await noBet(target);
  });
  test('a transaction cannot acquire a second wallet lock', async () => {
    const first = await open(); const second = await open();
    await expect(work().transaction(async scope => { await scope.lockWallet(first.id); await scope.lockWallet(second.id); })).rejects.toThrow('only one wallet');
    await noBet(first); await noBet(second);
  });
  test('a real outbox constraint failure rolls back the entire BET and is not an identity conflict', async () => {
    const target = await open(); const event = await fresh().findOneOrFail(OutboxMessageRecord, { aggregateId: target.id });
    const ids = [randomUUID(), randomUUID(), randomUUID(), event.id];
    const useCase = new ProcessWagerTransaction(work(), new WagerTransactionIdentity(), { newId: () => ids.shift()!, now: () => new Date(), retryDelay: async () => {} });
    let failure: unknown;
    try { await useCase.execute(command(target)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(UniqueConstraintViolationException);
    expect(failure).not.toBeInstanceOf(WagerIdentityCollisionError);
    await noBet(target);
  });
  test('a controlled PENDING fixture is not returned as a completed BET or debited', async () => {
    const target = await open(); const input = command(target);
    const pending = new WagerTransactionIdentity().createCandidate(input, randomUUID(), new Date());
    await work().transaction(scope => scope.insertPending(pending));
    await expect(process().execute(input)).rejects.toBeInstanceOf(WagerResultUnavailableError);
    expect((await fresh().findOneOrFail(WagerTransactionRecord, pending.id)).status).toBe(Status.Pending);
    expect(await fresh().count(LedgerEntryRecord, { walletId: target.id })).toBe(1);
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).balance).toBe('100.00');
  });
  test('currency mismatch uses the domain rejection without debit', async () => {
    const target = await open();
    const result = await process().execute(command(target, { money: { amount: '1.00', currency: 'USD' } }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.CurrencyMismatch, balance: { currency: 'BRL', amount: '100.00' } });
    await consistent(target, '100.00');
  });
  test('a missing wallet cannot commit a BET identity', async () => {
    const input = command({ id: randomUUID(), playerId: randomUUID(), balance: { amount: '0.00', currency: 'BRL' } });
    await expect(process().execute(input)).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    expect(await fresh().count(WagerTransactionRecord, { idempotencyKey: input.idempotencyKey })).toBe(0);
  });
});
