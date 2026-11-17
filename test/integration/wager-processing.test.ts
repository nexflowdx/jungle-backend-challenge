import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { TransactionContext, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { walletMapper } from '../../src/database/domain-mappers';
import { LedgerEntryRecord, OutboxMessageRecord, WagerTransactionRecord, WalletRecord } from '../../src/database/entities';
import { createPersistence } from '../../src/database/orm';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { Money } from '../../src/shared/domain/money';
import { assertPersistenceTestEnvironment } from './environment';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
const at = new Date('2026-11-17T12:00:00.000Z');

// These tests exercise transaction infrastructure, not ProcessWagerTransaction or wager rules.
describe.skipIf(!enabled)('Wager adapter PostgreSQL transaction infrastructure (5.1)', () => {
  let orm: MikroORM;
  const fresh = () => orm.em.fork();
  const adapter = () => new PostgresWagerProcessingUnitOfWork(orm);
  const fixture = (currency = 'BRL', playerId: string = randomUUID()) => Wallet.open({
    id: randomUUID(), playerId, initialBalance: Money.zero(currency), at,
  });
  function currentManager() {
    // ORM access is confined to infrastructure tests. The application port exposes no manager.
    const manager = TransactionContext.getEntityManager();
    if (!manager) throw new Error('Expected the adapter callback to have a real transaction context');
    return manager;
  }
  async function assertFixture(wallet: Wallet, exists: boolean): Promise<void> {
    expect(await fresh().count(WalletRecord, { id: wallet.id })).toBe(exists ? 1 : 0);
    if (exists) {
      const record = await fresh().findOneOrFail(WalletRecord, wallet.id);
      expect(record.balance).toBe('0.00');
      expect(record.currency).toBe(wallet.currency);
      expect(record.version).toBe(1);
    }
    expect(await fresh().count(WagerTransactionRecord, { walletId: wallet.id })).toBe(0);
    expect(await fresh().count(LedgerEntryRecord, { walletId: wallet.id })).toBe(0);
    expect(await fresh().count(OutboxMessageRecord, { aggregateId: wallet.id })).toBe(0);
  }

  beforeAll(async () => {
    assertPersistenceTestEnvironment(process.env);
    orm = await createPersistence({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test',
      user: 'diagnostic', password: process.env.PGPASSWORD! });
    await orm.getMigrator().up();
  }, 30000);
  afterAll(async () => { if (orm) await orm.close(true); });

  test('runs a callback inside an isolated PostgreSQL transaction and returns its nonfinancial value', async () => {
    const result = await adapter().transaction(async () => {
      const manager = currentManager();
      expect(manager.isInTransaction()).toBe(true);
      expect(manager.getTransactionContext()).toBeDefined();
      expect(manager).not.toBe(orm.em);
      return 'infrastructure callback completed';
    });
    expect(result).toBe('infrastructure callback completed');
    expect(TransactionContext.getEntityManager()).toBeUndefined();
  });

  test('commits a zero-wallet fixture and keeps its flushed write invisible until commit', async () => {
    const wallet = fixture();
    let observed = false;
    await adapter().transaction(async () => {
      const manager = currentManager();
      await manager.persistAndFlush(walletMapper.toRecord(wallet));
      expect(await manager.count(WalletRecord, { id: wallet.id })).toBe(1);
      await assertFixture(wallet, false);
      observed = true;
    });
    expect(observed).toBe(true);
    await assertFixture(wallet, true);
  });

  test.each(['BRL', 'USD'])('rolls back a real flushed %s fixture write and propagates the original error', async currency => {
    const wallet = fixture(currency);
    const failure = new Error('Injected infrastructure failure after a real write');
    await expect(adapter().transaction(async () => {
      const manager = currentManager();
      await manager.persistAndFlush(walletMapper.toRecord(wallet));
      expect(await manager.count(WalletRecord, { id: wallet.id })).toBe(1);
      throw failure;
    })).rejects.toBe(failure);
    await assertFixture(wallet, false);
    // A fresh attempt with the same identity proves the failed transaction left no row behind.
    await adapter().transaction(async () => { await currentManager().persistAndFlush(walletMapper.toRecord(wallet)); });
    await assertFixture(wallet, true);
  });

  test('rolls back both flushed fixture writes when the callback fails after the second write', async () => {
    const wallets = [fixture(), fixture('USD')];
    const failure = new Error('Injected infrastructure failure after two writes');
    await expect(adapter().transaction(async () => {
      const manager = currentManager();
      for (const wallet of wallets) await manager.persistAndFlush(walletMapper.toRecord(wallet));
      expect(await manager.count(WalletRecord, { id: { $in: wallets.map(wallet => wallet.id) } })).toBe(2);
      throw failure;
    })).rejects.toBe(failure);
    for (const wallet of wallets) await assertFixture(wallet, false);
  });

  test('propagates an asynchronous callback error before any write', async () => {
    const failure = new Error('Infrastructure callback failed');
    await expect(adapter().transaction(async () => {
      expect(currentManager().isInTransaction()).toBe(true);
      await Promise.resolve();
      throw failure;
    })).rejects.toBe(failure);
    expect(TransactionContext.getEntityManager()).toBeUndefined();
  });

  test('propagates a deferred commit failure and rolls back the invalid fixture', async () => {
    const wallet = Wallet.open({ id: randomUUID(), playerId: randomUUID(),
      initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }), at,
      opening: { id: randomUUID(), transactionId: randomUUID() } });
    let callbackCompleted = false;
    await expect(adapter().transaction(async () => {
      // Intentionally omit its ledger/OPENING: existing deferred constraints must reject commit.
      await currentManager().persistAndFlush(walletMapper.toRecord(wallet));
      callbackCompleted = true;
    })).rejects.toMatchObject({ code: '23514' });
    expect(callbackCompleted).toBe(true);
    await assertFixture(wallet, false);
  });

  test('propagates a SQL constraint failure and rolls back the preceding fixture write', async () => {
    const first = fixture();
    const duplicate = fixture('BRL', first.playerId);
    await expect(adapter().transaction(async () => {
      const manager = currentManager();
      await manager.persistAndFlush(walletMapper.toRecord(first));
      await manager.persistAndFlush(walletMapper.toRecord(duplicate));
    })).rejects.toBeInstanceOf(UniqueConstraintViolationException);
    await assertFixture(first, false);
    await assertFixture(duplicate, false);
  });

  test('concurrent adapter callbacks keep independent contexts and commit/rollback outcomes', async () => {
    const first = fixture();
    const second = fixture('USD');
    const managers = new Set<ReturnType<typeof currentManager>>();
    const failure = new Error('Only the first infrastructure transaction fails');
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const work = adapter();
    const results = await Promise.allSettled([first, second].map(wallet => work.transaction(async () => {
      const manager = currentManager();
      managers.add(manager);
      await manager.persistAndFlush(walletMapper.toRecord(wallet));
      if (++entered === 2) release();
      await barrier;
      expect(currentManager()).toBe(manager);
      if (wallet === first) throw failure;
    })));
    expect(managers.size).toBe(2);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: failure });
    expect(results[1]!.status).toBe('fulfilled');
    await assertFixture(first, false);
    await assertFixture(second, true);
  });
});
