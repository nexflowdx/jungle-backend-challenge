import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { LedgerEntryRecord, OutboxMessageRecord, WagerTransactionRecord, WalletRecord } from '../../src/database/entities';
import { createPersistence } from '../../src/database/orm';
import { rehydrateMoney } from '../../src/database/money-mapping';
import { OpenWallet, type OpeningRuntime, type OpenWalletResult } from '../../src/modules/wallets/application/open-wallet';
import { WalletAlreadyExistsError, type WalletOpeningUnitOfWork } from '../../src/modules/wallets/application/wallet-opening-unit-of-work';
import { PostgresWalletOpeningUnitOfWork } from '../../src/modules/wallets/infrastructure/postgres-wallet-opening-unit-of-work';
import { assertPersistenceTestEnvironment } from './environment';
import { withOpeningFailure } from './opening-failures';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
const at = new Date('2026-11-17T12:00:00.000Z');
const command = (playerId: string = randomUUID(), amount = '100.00', currency = 'BRL') => ({
  playerId, initialBalance: { amount, currency }, correlationId: randomUUID(), causationId: randomUUID(),
});
function runtimeFor(walletId: string = randomUUID()): OpeningRuntime {
  let first = true;
  return { newId: () => { if (first) { first = false; return walletId; } return randomUUID(); }, now: () => at };
}

describe.skipIf(!enabled)('Atomic wallet opening PostgreSQL integration (4.1–4.3)', () => {
  let orm: MikroORM;
  const fresh = () => orm.em.fork();
  const unitOfWork = () => new PostgresWalletOpeningUnitOfWork(orm);
  const useCase = (runtime = runtimeFor(), work: WalletOpeningUnitOfWork = unitOfWork()) => new OpenWallet(work, runtime);

  async function assertAbsent(walletId: string): Promise<void> {
    expect(await fresh().count(WalletRecord, { id: walletId })).toBe(0);
    expect(await fresh().count(WagerTransactionRecord, { walletId })).toBe(0);
    expect(await fresh().count(LedgerEntryRecord, { walletId })).toBe(0);
    expect(await fresh().count(OutboxMessageRecord, { aggregateId: walletId })).toBe(0);
  }

  async function assertStored(result: OpenWalletResult): Promise<void> {
    const wallet = await fresh().findOneOrFail(WalletRecord, result.id);
    expect(wallet.playerId).toBe(result.playerId);
    expect(result.balance.currency).toBe(wallet.currency);
    expect(wallet.balance).toBe(result.balance.amount);
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(at);
    expect(wallet.updatedAt).toEqual(at);
    const transactions = await fresh().find(WagerTransactionRecord, { walletId: result.id });
    const entries = await fresh().find(LedgerEntryRecord, { walletId: result.id });
    const events = await fresh().find(OutboxMessageRecord, { aggregateId: result.id }, { orderBy: { eventType: 'asc' } });
    if (rehydrateMoney(wallet.balance, wallet.currency).isZero()) {
      expect(transactions).toHaveLength(0);
      expect(entries).toHaveLength(0);
      expect(events).toHaveLength(0);
    } else {
      expect(transactions).toHaveLength(1);
      expect(entries).toHaveLength(1);
      const transaction = transactions[0]!;
      const entry = entries[0]!;
      expect(transaction).toMatchObject({ kind: 'OPENING', status: 'PROCESSED', playerId: result.playerId,
        amount: wallet.balance, currency: wallet.currency, balance: wallet.balance, balanceCurrency: wallet.currency,
        completedAt: at, referenceTransactionId: null, acceptedBalance: null });
      expect(transaction.payloadHash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry).toMatchObject({ transactionId: transaction.id, walletId: result.id, direction: 'CREDIT',
        amount: wallet.balance, currency: wallet.currency, balanceBefore: '0.00', balanceAfter: wallet.balance, walletVersion: 1 });
      expect(events.map(event => event.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      for (const event of events) {
        expect(event.publishedAt).toBeNull();
        expect(event.attempts).toBe(0);
        expect(event.leaseToken).toBeNull();
        expect(event.payload).toMatchObject({ eventId: event.id, eventType: event.eventType, version: 1,
          aggregateId: wallet.id, occurredAt: at.toISOString(),
          data: { walletId: wallet.id, transactionId: transaction.id, money: result.balance } });
      }
    }
    const [row] = await fresh().execute<{ balance: string; reconstructed: string }[]>(`SELECT w.balance,
      COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0) AS reconstructed
      FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id=w.id WHERE w.id=? GROUP BY w.id`, [wallet.id]);
    expect(row).toBeDefined();
    expect(rehydrateMoney(row!.balance, wallet.currency).equals(rehydrateMoney(row!.reconstructed, wallet.currency))).toBe(true);
  }

  beforeAll(async () => {
    assertPersistenceTestEnvironment(process.env);
    orm = await createPersistence({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test',
      user: 'diagnostic', password: process.env.PGPASSWORD! });
    await orm.getMigrator().up();
  }, 30000);
  afterAll(async () => { if (orm) await orm.close(true); });

  test.each(['BRL', 'USD'])('commits a zero %s opening without ledger, operation or outbox', async currency => {
    const input = command(randomUUID(), '0.00', currency);
    const result = await useCase().execute(input);
    expect(result).toMatchObject({ playerId: input.playerId, balance: input.initialBalance, version: 1 });
    await assertStored(result);
  });

  test.each([
    ['0.01', 'BRL'], ['100.00', 'BRL'], ['9007199254740993.01', 'BRL'], ['92233720368547758.07', 'BRL'],
    ['0.01', 'USD'], ['100.00', 'USD'], ['9007199254740993.01', 'USD'], ['92233720368547758.07', 'USD'],
  ])('commits exact %s %s with OPENING, credit and outbox in version one', async (amount, currency) => {
    const input = command(randomUUID(), amount!, currency!);
    const result = await useCase().execute(input);
    expect(result.balance).toEqual(input.initialBalance);
    await assertStored(result);
    const events = await fresh().find(OutboxMessageRecord, { aggregateId: result.id });
    for (const event of events) expect(event.payload).toMatchObject({ correlationId: input.correlationId, causationId: input.causationId });
  });

  test.each([
    { amount: '-0.01', currency: 'BRL' }, { amount: '1.001', currency: 'BRL' },
    { amount: '92233720368547758.08', currency: 'BRL' }, { amount: '1.00', currency: 'EUR' },
    { amount: 1 as unknown as string, currency: 'BRL' }, { amount: 'NaN', currency: 'BRL' },
  ])('rejects invalid opening money %j with no persisted artifacts', async initialBalance => {
    const id = randomUUID();
    await expect(useCase(runtimeFor(id)).execute({ ...command(), initialBalance })).rejects.toThrow();
    await assertAbsent(id);
  });

  test.each(['0.00', '100.00'])('duplicate of an initial %s opening conflicts without a second financial effect', async amount => {
    const input = command(randomUUID(), amount);
    const result = await useCase().execute(input);
    const duplicateId = randomUUID();
    await expect(useCase(runtimeFor(duplicateId)).execute({ ...input, initialBalance: { amount: '200.00', currency: 'BRL' } }))
      .rejects.toBeInstanceOf(WalletAlreadyExistsError);
    expect(await fresh().count(WalletRecord, { playerId: input.playerId, currency: 'BRL' })).toBe(1);
    await assertAbsent(duplicateId);
    await assertStored(result);
  });

  test('the same player can open BRL and USD concurrently', async () => {
    const playerId = randomUUID();
    const results = await Promise.all(['BRL', 'USD'].map(currency => useCase().execute(command(playerId, '100.00', currency))));
    expect(await fresh().count(WalletRecord, { playerId })).toBe(2);
    for (const result of results) await assertStored(result);
  });

  test.each(['0.00', '100.00'])('concurrent %s attempts for one player/currency create only one wallet', async amount => {
    const playerId = randomUUID();
    const ids = Array.from({ length: 8 }, () => randomUUID());
    const results = await Promise.allSettled(ids.map(id => useCase(runtimeFor(id)).execute(command(playerId, amount))));
    const successes = results.filter(result => result.status === 'fulfilled');
    expect(successes).toHaveLength(1);
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(WalletAlreadyExistsError);
    const winner = successes[0]!.value;
    expect(winner.balance.amount).toBe(amount);
    expect(await fresh().count(WalletRecord, { playerId })).toBe(1);
    await assertStored(winner);
    for (const id of ids) if (id !== winner.id) await assertAbsent(id);
  });

  test.each(['after-wallet', 'after-opening', 'after-ledger', 'after-outbox', 'before-commit'] as const)(
    'rolls back every positive opening artifact on failure %s and allows a clean retry', async point => {
      const id = randomUUID();
      const input = command();
      const failing = withOpeningFailure(unitOfWork(), point);
      await expect(useCase(runtimeFor(id), failing).execute(input)).rejects.toThrow(`Injected opening failure: ${point}`);
      await assertAbsent(id);
      const result = await useCase(runtimeFor(id)).execute(input);
      await assertStored(result);
    },
  );

  test.each(['after-wallet', 'before-commit'] as const)('rolls back a zero opening on failure %s', async point => {
    const id = randomUUID();
    const input = command(randomUUID(), '0.00');
    await expect(useCase(runtimeFor(id), withOpeningFailure(unitOfWork(), point)).execute(input)).rejects.toThrow('Injected opening failure');
    await assertAbsent(id);
    await assertStored(await useCase(runtimeFor(id)).execute(input));
  });

  test('wallet, OPENING, ledger and outbox are invisible to another connection before commit', async () => {
    const id = randomUUID();
    let observed = false;
    const delegate = unitOfWork();
    const inspecting: WalletOpeningUnitOfWork = {
      transaction: callback => delegate.transaction(async transaction => {
        const result = await callback(transaction);
        await assertAbsent(id);
        observed = true;
        return result;
      }),
    };
    const result = await useCase(runtimeFor(id), inspecting).execute(command());
    expect(observed).toBe(true);
    await assertStored(result);
  });

  test('a deferred integrity failure at commit rolls back all writes and never returns success', async () => {
    const id = randomUUID();
    let callbackCompleted = false;
    const delegate = unitOfWork();
    const incomplete: WalletOpeningUnitOfWork = {
      transaction: callback => delegate.transaction(async transaction => {
        const result = await callback({ ...transaction, insertLedgerEntry: async () => {} });
        callbackCompleted = true;
        return result;
      }),
    };
    await expect(useCase(runtimeFor(id), incomplete).execute(command())).rejects.toMatchObject({ code: '23514' });
    expect(callbackCompleted).toBe(true);
    await assertAbsent(id);
  });

  test('an outbox uniqueness failure rolls back the new opening and preserves previously committed events', async () => {
    const existing = await useCase().execute(command());
    const event = await fresh().findOneOrFail(OutboxMessageRecord, { aggregateId: existing.id });
    const id = randomUUID();
    const ids = [id, randomUUID(), randomUUID(), randomUUID(), event.id];
    const runtime = { newId: () => ids.shift()!, now: () => at };
    await expect(useCase(runtime).execute(command())).rejects.toBeInstanceOf(UniqueConstraintViolationException);
    await assertAbsent(id);
    await assertStored(existing);
  });

  test('a wallet primary-key collision is not misclassified as a player/currency conflict', async () => {
    const existing = await useCase().execute(command(randomUUID(), '0.00'));
    const input = command();
    await expect(useCase(runtimeFor(existing.id)).execute(input)).rejects.toBeInstanceOf(UniqueConstraintViolationException);
    expect(await fresh().count(WalletRecord, { playerId: input.playerId })).toBe(0);
    await assertStored(existing);
  });
});
