import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { wrap } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { createPersistence, persistenceMigrations } from '../../src/database/orm';
import { WalletRecord, WagerTransactionRecord, LedgerEntryRecord, InboxMessageRecord, OutboxMessageRecord } from '../../src/database/entities';
import { ledgerMapper, outboxRecord, transactionMapper, walletMapper } from '../../src/database/domain-mappers';
import { runtimePrivilegesSql } from '../../src/database/runtime-privileges';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { LedgerDirection } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import { WalletBalanceChanged } from '../../src/modules/wallets/domain/wallet-balance-changed';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { type CreateWagerTransactionProps, FailureCode, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';
import { Money } from '../../src/shared/domain/money';
import { assertPersistenceTestEnvironment } from './environment';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
const at = new Date('2026-11-17T12:00:00.000Z');
const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
type SqlValues = Record<string, unknown>;

describe.skipIf(!enabled)('PostgreSQL disposable integration (3.1–3.5)', () => {
  let orm: MikroORM;
  const fresh = () => orm.em.fork();
  const sql = <T extends SqlValues[] = SqlValues[]>(query: string, params: unknown[] = []) => fresh().execute<T>(query, params);
  const atomic = <T>(work: (em: EntityManager) => Promise<T>) => fresh().transactional(work);
  async function insert(em: EntityManager, table: string, values: SqlValues): Promise<void> {
    const columns = Object.keys(values);
    await em.execute(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(values));
  }
  async function invalid(work: (em: EntityManager) => Promise<unknown>, code = '23514'): Promise<void> {
    let caught: unknown;
    try { await atomic(work); } catch (error) { caught = error; }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe(code);
  }
  async function invalidAtCommit(work: (em: EntityManager) => Promise<unknown>): Promise<void> {
    let statementsCompleted = false;
    await invalid(async em => { await work(em); statementsCompleted = true; });
    expect(statementsCompleted).toBe(true);
  }
  async function assertBalanceMatchesLedger(walletId: string): Promise<void> {
    const [row] = await sql(`SELECT w.balance, COALESCE(SUM(CASE e.direction
      WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0) AS reconstructed
      FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id=w.id
      WHERE w.id=? GROUP BY w.id`, [walletId]);
    expect(row).toBeDefined();
    expect(money(row!.balance as string).equals(money(row!.reconstructed as string))).toBe(true);
  }
  function props(target: Wallet, overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
    const id = randomUUID();
    return {
      id, providerId: 'provider', externalTransactionId: `external-${id}`, idempotencyKey: `key-${id}`,
      payloadHash: `hash-${id}`, walletId: target.id, playerId: target.playerId,
      roundId: 'round', gameId: 'game', kind: Kind.Bet, money: money('10.00', target.currency),
      createdAt: at, ...overrides,
    };
  }
  async function open(amount = '100.00', currency = 'BRL'): Promise<Wallet> {
    const openingId = randomUUID();
    const target = Wallet.open({
      id: randomUUID(), playerId: randomUUID(), initialBalance: money(amount, currency), at,
      opening: { id: randomUUID(), transactionId: openingId },
    });
    await atomic(async em => {
      em.persist(walletMapper.toRecord(target));
      if (target.balance.isPositive()) {
        const tx = WagerTransaction.createOpening({ ...props(target, { id: openingId }), money: target.balance });
        tx.markProcessed(undefined, target.balance, at);
        em.persist(transactionMapper.toRecord(tx));
        em.persist(ledgerMapper.toRecord(target.pendingLedgerEntries[0]!));
      }
      await em.flush();
    });
    return walletMapper.toDomain(walletMapper.toRecord(target));
  }
  function pendingValues(target: Wallet, overrides: SqlValues = {}): SqlValues {
    const id = randomUUID();
    return { id, provider_id: 'provider', external_transaction_id: `external-${id}`,
      idempotency_key: `key-${id}`, payload_hash: `hash-${id}`, wallet_id: target.id,
      player_id: target.playerId, round_id: 'round', game_id: 'game', kind: 'BET',
      amount: '10.00', currency: target.currency, status: 'PENDING', created_at: at, ...overrides };
  }
  function processedValues(target: Wallet, overrides: SqlValues = {}): SqlValues {
    return pendingValues(target, { status: 'PROCESSED', balance: '90.00',
      balance_currency: target.currency, completed_at: at, ...overrides });
  }
  function ledgerValues(target: Wallet, txId: unknown, overrides: SqlValues = {}): SqlValues {
    return { id: randomUUID(), wallet_id: target.id, transaction_id: txId,
      direction: 'DEBIT', amount: '10.00', currency: target.currency,
      balance_before: '100.00', balance_after: '90.00', wallet_version: 2, created_at: at, ...overrides };
  }
  async function apply(target: Wallet, overrides: Partial<CreateWagerTransactionProps> = {}, reference?: WagerTransaction): Promise<WagerTransaction> {
    const tx = WagerTransaction.create(props(target, overrides));
    const entry = tx.process(target, { at, ledgerEntryId: randomUUID(), priorReversals: [], ...(reference ? { reference } : {}) });
    await atomic(async em => {
      await em.nativeUpdate(WalletRecord, target.id, { balance: target.balance.toString(), version: target.version, updatedAt: target.updatedAt });
      em.persist(transactionMapper.toRecord(tx));
      if (entry) em.persist(ledgerMapper.toRecord(entry));
      await em.flush();
    });
    return tx;
  }

  beforeAll(async () => {
    assertPersistenceTestEnvironment(process.env);
    orm = await createPersistence({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test',
      user: 'diagnostic', password: process.env.PGPASSWORD! });
    await orm.getMigrator().up();
    await sql('CREATE ROLE wager_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT');
    await sql(runtimePrivilegesSql('wager_runtime'));
  }, 30000);
  afterAll(async () => { if (orm) await orm.close(true); });

  test('authenticates against real PostgreSQL in the isolated database', async () => {
    const [connection] = await sql('SELECT version() AS version,current_database() AS database,current_user AS role');
    expect(connection!.version).toContain('PostgreSQL 17.');
    expect(connection!.database).toBe('jungle_persistence_test');
    expect(connection!.role).toBe('diagnostic');
  });
  test('applies the four versioned migrations exactly once', async () => {
    expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(persistenceMigrations.length);
    expect(await orm.getMigrator().up()).toHaveLength(0);
  });
  test.each(['0.00', '0.01', '9007199254740993.01', '92233720368547758.07'])('round-trips Money %s through ORM and pg string parser', async amount => {
    const target = await open(amount, 'USD');
    const record = await fresh().findOneOrFail(WalletRecord, target.id);
    expect(typeof record.balance).toBe('string');
    expect(walletMapper.toDomain(record).balance.equals(target.balance)).toBe(true);
    const [raw] = await sql('SELECT balance FROM wallets WHERE id = ?', [target.id]);
    expect(typeof raw!.balance).toBe('string');
    expect(raw!.balance).toBe(amount);
  });
  test('all monetary columns are unconstrained NUMERIC without typmod', async () => {
    const rows = await sql(`SELECT table_name,column_name,numeric_precision,numeric_scale
      FROM information_schema.columns WHERE table_schema='public' AND data_type='numeric'`);
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.numeric_precision).toBeNull();
      expect(row.numeric_scale).toBeNull();
    }
  });
  test.each([Status.Pending, Status.PendingReference])('ORM persists and hydrates nullable monetary snapshots for %s', async status => {
    const target = await open();
    const tx = WagerTransaction.create(props(target, { kind: Kind.Refund, referenceExternalTransactionId: 'missing' }));
    if (status === Status.PendingReference) tx.markPendingReference(target.balance);
    await atomic(async em => {
      em.persist(transactionMapper.toRecord(tx));
      await em.flush();
    });
    const em = fresh();
    const record = await em.findOneOrFail(WagerTransactionRecord, { id: tx.id, walletId: target.id });
    const accepted = status === Status.PendingReference ? '100.00' : null;
    expect(record.status).toBe(status);
    expect(record.walletId).toBe(target.id);
    expect(record.acceptedBalance).toBe(accepted);
    expect(record.balance).toBeNull();
    const snapshot = wrap(record, true).__originalEntityData!;
    expect(snapshot.acceptedBalance).toBe(accepted);
    expect(snapshot.balance).toBeNull();
    expect(transactionMapper.toDomain(record).balance?.toString()).toBe(accepted ?? undefined);
    em.getUnitOfWork().computeChangeSets();
    expect(em.getUnitOfWork().getChangeSets()).toHaveLength(0);
    await em.flush();
    expect(await fresh().count(LedgerEntryRecord, { transactionId: tx.id })).toBe(0);
    await assertBalanceMatchesLedger(target.id);
  });
  test('ORM orders scalar foreign keys when persisting an opening graph and keeps loaded snapshots unchanged', async () => {
    const txId = randomUUID();
    const target = Wallet.open({ id: randomUUID(), playerId: randomUUID(), initialBalance: money('9007199254740993.01'), at,
      opening: { id: randomUUID(), transactionId: txId } });
    const tx = WagerTransaction.createOpening({ ...props(target, { id: txId }), money: target.balance });
    tx.markProcessed(undefined, target.balance, at);
    const entry = target.pendingLedgerEntries[0]!;
    await atomic(async em => {
      // Deliberately reversed: Unit of Work must insert wallet, transaction, then ledger.
      em.persist([ledgerMapper.toRecord(entry), transactionMapper.toRecord(tx), walletMapper.toRecord(target)]);
      await em.flush();
    });
    const em = fresh();
    const storedWallet = await em.findOneOrFail(WalletRecord, target.id);
    const storedTx = await em.findOneOrFail(WagerTransactionRecord, { id: tx.id, walletId: target.id });
    const storedEntry = await em.findOneOrFail(LedgerEntryRecord, { walletId: target.id, transactionId: tx.id });
    expect(storedWallet.version).toBe(1);
    expect(storedWallet.balance).toBe('9007199254740993.01');
    expect(storedTx.acceptedBalance).toBeNull();
    expect(storedTx.balance).toBe(storedWallet.balance);
    expect(storedEntry.id).toBe(entry.id);
    expect(storedEntry.walletId).toBe(target.id);
    expect(storedEntry.transactionId).toBe(tx.id);
    expect(wrap(storedEntry, true).__originalEntityData).toMatchObject({ walletId: target.id, transactionId: tx.id });
    em.getUnitOfWork().computeChangeSets();
    expect(em.getUnitOfWork().getChangeSets()).toHaveLength(0);
    await em.flush(); // Spurious UPDATEs would fail on the immutable transaction/ledger.
    expect(await fresh().count(LedgerEntryRecord, { walletId: target.id })).toBe(1);
    await assertBalanceMatchesLedger(target.id);
  });
  test('ORM updates pending null snapshots through acceptance and rejection without a financial effect', async () => {
    const target = await open();
    const tx = WagerTransaction.create(props(target, { kind: Kind.Refund, referenceExternalTransactionId: 'missing' }));
    await atomic(async em => { em.persist(transactionMapper.toRecord(tx)); await em.flush(); });
    await atomic(async em => {
      const record = await em.findOneOrFail(WagerTransactionRecord, { id: tx.id, walletId: target.id });
      const restored = transactionMapper.toDomain(record);
      restored.markPendingReference(target.balance);
      em.assign(record, transactionMapper.toRecord(restored));
      await em.flush();
      expect(wrap(record, true).__originalEntityData).toMatchObject({ acceptedBalance: '100.00', balance: null });
    });
    await atomic(async em => {
      const record = await em.findOneOrFail(WagerTransactionRecord, tx.id);
      const restored = transactionMapper.toDomain(record);
      restored.reject(FailureCode.ReferenceNotFound, target.balance, at);
      em.assign(record, transactionMapper.toRecord(restored));
      await em.flush();
    });
    const record = await fresh().findOneOrFail(WagerTransactionRecord, tx.id);
    expect(record.status).toBe(Status.Rejected);
    expect(record.acceptedBalance).toBe('100.00');
    expect(record.balance).toBe('100.00');
    expect(record.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(await fresh().count(LedgerEntryRecord, { transactionId: tx.id })).toBe(0);
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).version).toBe(1);
    await assertBalanceMatchesLedger(target.id);
  });
  test.each(['-0.01', '1.001', '1.230', 'NaN', 'Infinity', '-Infinity', '92233720368547758.08'])('rejects invalid SQL money %s in every monetary column', async amount => {
    const target = await open();
    const invalidWalletId = randomUUID();
    await invalid(em => insert(em, 'wallets', { id: invalidWalletId, player_id: randomUUID(), currency: 'BRL',
      balance: amount, version: 1, created_at: at, updated_at: at }));
    for (const column of ['amount', 'accepted_balance', 'balance']) {
      await invalid(em => insert(em, 'wager_transactions', pendingValues(target, {
        [column]: amount, ...(column === 'accepted_balance' ? { accepted_currency: 'BRL' } : {}),
      })));
    }
    for (const column of ['amount', 'balance_before', 'balance_after']) {
      await invalid(em => insert(em, 'wallet_ledger_entries', ledgerValues(target, randomUUID(), { [column]: amount })));
    }
    expect(await fresh().count(WalletRecord, { id: invalidWalletId })).toBe(0);
  });
  test('does not silently round excess scale and accepts exact SQL integer/one-place inputs', async () => {
    const target = await open();
    await atomic(em => insert(em, 'wager_transactions', pendingValues(target, { amount: '12.3' })));
    const [row] = await sql('SELECT amount FROM wager_transactions WHERE wallet_id=? AND amount=12.3', [target.id]);
    expect(row!.amount).toBe('12.3');
    const record = await fresh().findOneOrFail(WagerTransactionRecord, { walletId: target.id, status: Status.Pending });
    expect(transactionMapper.toDomain(record).money.toString()).toBe('12.30');
  });
  test('enforces wallet/player/currency uniqueness, identities and supported currencies', async () => {
    const target = await open('0.00');
    await invalid(em => insert(em, 'wallets', { id: randomUUID(), player_id: target.playerId,
      currency: target.currency, balance: '0.00', version: 1, created_at: at, updated_at: at }), '23505');
    await invalid(em => insert(em, 'wallets', { id: randomUUID(), player_id: randomUUID(),
      currency: 'EUR', balance: '0.00', version: 1, created_at: at, updated_at: at }));
    await invalid(em => insert(em, 'wager_transactions', pendingValues(target, { player_id: 'another-player' })), '23503');
    await invalid(em => insert(em, 'wager_transactions', pendingValues(target, { wallet_id: randomUUID() })), '23503');
    await invalid(em => insert(em, 'wager_transactions', pendingValues(target, { kind: 'INVALID' })));
  });
  test('enforces global idempotency and provider-scoped external identity', async () => {
    const target = await open();
    const values = pendingValues(target);
    await atomic(em => insert(em, 'wager_transactions', values));
    await invalid(em => insert(em, 'wager_transactions', pendingValues(target, { idempotency_key: values.idempotency_key })), '23505');
    await invalid(em => insert(em, 'wager_transactions', pendingValues(target, { external_transaction_id: values.external_transaction_id })), '23505');
    await atomic(em => insert(em, 'wager_transactions', pendingValues(target, { provider_id: 'another-provider', external_transaction_id: values.external_transaction_id })));
  });
  test('freezes terminal transaction and pending acceptance snapshot', async () => {
    const target = await open();
    const tx = await apply(target);
    await invalid(em => em.execute('UPDATE wager_transactions SET balance=91 WHERE id=?', [tx.id]));
    await invalid(em => em.execute('DELETE FROM wager_transactions WHERE id=?', [tx.id]));
    const pending = pendingValues(target, { kind: 'REFUND', reference_external_transaction_id: 'missing',
      status: 'PENDING_REFERENCE', accepted_balance: '90.00', accepted_currency: 'BRL' });
    await atomic(em => insert(em, 'wager_transactions', pending));
    await invalid(em => em.execute('UPDATE wager_transactions SET accepted_balance=80 WHERE id=?', [pending.id]));
    await invalid(em => em.execute("UPDATE wager_transactions SET status='PENDING' WHERE id=?", [pending.id]));
    await invalid(em => em.execute("UPDATE wager_transactions SET amount=11 WHERE id=?", [pending.id]));
  });
  test('ledger rejects duplicate movement/version, bad arithmetic and currency mismatch', async () => {
    const target = await open();
    const original = await fresh().findOneOrFail(LedgerEntryRecord, { walletId: target.id });
    await invalid(em => insert(em, 'wallet_ledger_entries', ledgerValues(target, original.transactionId)), '23505');
    const pending = pendingValues(target);
    await atomic(em => insert(em, 'wager_transactions', pending));
    await invalid(em => insert(em, 'wallet_ledger_entries', ledgerValues(target, pending.id, { wallet_version: 1 })), '23505');
    await invalid(em => insert(em, 'wallet_ledger_entries', ledgerValues(target, pending.id, { balance_after: '99.00' })));
    await invalid(em => insert(em, 'wallet_ledger_entries', ledgerValues(target, pending.id, { currency: 'USD' })), '23503');
  });
  test.each(['UPDATE wallet_ledger_entries SET amount=amount', 'DELETE FROM wallet_ledger_entries', 'TRUNCATE wallet_ledger_entries'])('ledger mutation blocked even for schema owner: %s', async query => {
    await open();
    await invalid(em => em.execute(query));
  });
  test('runtime role can write valid movements but cannot mutate ledger or administer schema', async () => {
    const target = await open();
    await atomic(async em => {
      await em.execute('SET LOCAL ROLE wager_runtime');
      const tx = WagerTransaction.create(props(target));
      const entry = tx.process(target, { at, ledgerEntryId: randomUUID(), priorReversals: [] })!;
      await em.execute('UPDATE wallets SET balance=?,version=? WHERE id=?', [target.balance.toString(), target.version, target.id]);
      em.persist([transactionMapper.toRecord(tx), ledgerMapper.toRecord(entry)]);
      await em.flush();
    });
    for (const query of ['UPDATE wallet_ledger_entries SET amount=amount', 'DELETE FROM wallet_ledger_entries',
      'TRUNCATE wallet_ledger_entries', 'ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ALL',
      "UPDATE wager_transactions SET payload_hash='tampered'"]) {
      await invalid(async em => { await em.execute('SET LOCAL ROLE wager_runtime'); await em.execute(query); }, '42501');
    }
  });
  test('temporary tables cannot bypass deferred financial correspondence', async () => {
    const target = await open();
    await invalid(async em => {
      await em.execute('SET LOCAL ROLE wager_runtime');
      await em.execute('CREATE TEMP TABLE wallet_ledger_entries (LIKE public.wallet_ledger_entries) ON COMMIT DROP');
      await insert(em, 'wallet_ledger_entries', ledgerValues(target, randomUUID()));
      await em.execute('UPDATE public.wallets SET balance=90,version=2 WHERE id=?', [target.id]);
    });
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).balance).toBe('100.00');
  });

  test('deferred constraints reject balance alone, version alone and positive opening alone at commit', async () => {
    const target = await open();
    await invalidAtCommit(em => em.execute('UPDATE wallets SET balance=99,version=2 WHERE id=?', [target.id]));
    await invalidAtCommit(em => em.execute('UPDATE wallets SET version=2 WHERE id=?', [target.id]));
    await invalidAtCommit(em => insert(em, 'wallets', { id: randomUUID(), player_id: randomUUID(), currency: 'BRL',
      balance: '1.00', version: 1, created_at: at, updated_at: at }));
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).balance).toBe('100.00');
  });
  test('deferred constraints reject ledger alone, processed transaction alone and nonfinancial ledger', async () => {
    const target = await open();
    await invalidAtCommit(em => insert(em, 'wager_transactions', processedValues(target)));
    for (const state of ['PENDING','REJECTED','FAILED','LOSS']) {
      await invalidAtCommit(async em => {
        const tx = state === 'LOSS' ? processedValues(target, { kind: 'LOSS' })
          : state === 'PENDING' ? pendingValues(target)
          : processedValues(target, { status: state, failure_code: 'INSUFFICIENT_FUNDS' });
        await insert(em, 'wager_transactions', tx);
        await insert(em, 'wallet_ledger_entries', ledgerValues(target, tx.id));
      });
    }
  });
  test('valid SQL may insert ledger before its transaction and finish the wallet before commit', async () => {
    const target = await open();
    const tx = processedValues(target);
    await atomic(async em => {
      await insert(em, 'wallet_ledger_entries', ledgerValues(target, tx.id));
      await insert(em, 'wager_transactions', tx);
      await em.execute('UPDATE wallets SET balance=90,version=2 WHERE id=?', [target.id]);
    });
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).balance).toBe('90.00');
  });
  test('SET CONSTRAINTS ALL IMMEDIATE catches incomplete financial writes before commit', async () => {
    const target = await open();
    await invalid(async em => {
      await em.execute('UPDATE wallets SET balance=90,version=2 WHERE id=?', [target.id]);
      await em.execute('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });
  test('rejects incorrect direction, amount, snapshot, sequence and skipped wallet version', async () => {
    const target = await open();
    for (const mismatch of ['direction','amount','snapshot','gap','version','predecessor']) {
      await invalid(async em => {
        const tx = processedValues(target, mismatch === 'amount' ? { amount: '11.00' }
          : mismatch === 'snapshot' ? { balance: '89.00' }
          : mismatch === 'direction' ? { kind: 'WIN' } : {});
        await insert(em, 'wager_transactions', tx);
        await insert(em, 'wallet_ledger_entries', ledgerValues(target, tx.id,
          mismatch === 'gap' ? { wallet_version: 3 } : mismatch === 'predecessor'
            ? { balance_before: '101.00', balance_after: '91.00' } : {}));
        await em.execute('UPDATE wallets SET balance=?,version=? WHERE id=?',
          [mismatch === 'predecessor' ? '91.00' : '90.00', ['gap','version'].includes(mismatch) ? 3 : 2, target.id]);
      });
    }
  });
  test('zero opening has no ledger; first movement is version two and LOSS does not change version', async () => {
    const target = await open('0.00');
    expect(await fresh().count(LedgerEntryRecord, { walletId: target.id })).toBe(0);
    await apply(target, { kind: Kind.Win, money: money('10.00') });
    const loss = await apply(target, { kind: Kind.Loss, money: money('0.00') });
    expect(loss.status).toBe(Status.Processed);
    const stored = await fresh().findOneOrFail(WalletRecord, target.id);
    expect(stored.balance).toBe('10.00');
    expect(stored.version).toBe(2);
    expect(await fresh().count(LedgerEntryRecord, { walletId: target.id })).toBe(1);
  });
  test('a zero opening cannot be forged at another version or with a non-opening version-one entry', async () => {
    await invalid(em => insert(em, 'wallets', { id: randomUUID(), player_id: randomUUID(), currency: 'BRL',
      balance: '0.00', version: 2, created_at: at, updated_at: at }));
    const target = await open('0.00');
    await invalid(async em => {
      const tx = processedValues(target, { kind: 'WIN', balance: '10.00' });
      await insert(em, 'wager_transactions', tx);
      await insert(em, 'wallet_ledger_entries', ledgerValues(target, tx.id,
        { direction: 'CREDIT', balance_before: '0.00', balance_after: '10.00', wallet_version: 1 }));
    });
  });
  test('supports multiple exact movements in one transaction without scanning full ledger', async () => {
    const target = await open();
    await atomic(async em => {
      for (let index = 0; index < 3; index++) {
        const tx = WagerTransaction.create(props(target));
        const entry = tx.process(target, { at, ledgerEntryId: randomUUID(), priorReversals: [] })!;
        await em.execute('UPDATE wallets SET balance=?,version=? WHERE id=?', [target.balance.toString(), target.version, target.id]);
        em.persist([transactionMapper.toRecord(tx), ledgerMapper.toRecord(entry)]);
        await em.flush();
      }
    });
    const [row] = await sql(`SELECT w.balance, SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END) AS reconstructed
      FROM wallets w JOIN wallet_ledger_entries e ON e.wallet_id=w.id WHERE w.id=? GROUP BY w.id`, [target.id]);
    expect(row!.balance).toBe('70.00');
    expect(row!.reconstructed).toBe(row!.balance);
  });
  test('rejected currency mismatch persists its original money and wallet result currency without ledger', async () => {
    const target = await open();
    const tx = await apply(target, { money: money('10.00','USD') });
    const restored = transactionMapper.toDomain(await fresh().findOneOrFail(WagerTransactionRecord, tx.id));
    expect(restored.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(restored.money.currency).toBe('USD');
    expect(restored.balance?.currency).toBe('BRL');
    expect(await fresh().count(LedgerEntryRecord, { transactionId: tx.id })).toBe(0);
  });

  test('preserves one reversal per reference/type and the approved REFUND plus ROLLBACK policy', async () => {
    const target = await open('200.00');
    const bet = await apply(target, { money: money('100.00') });
    const ref = { money: money('100.00'), referenceExternalTransactionId: bet.externalTransactionId };
    await apply(target, { ...ref, kind: Kind.Refund }, bet);
    await apply(target, { ...ref, kind: Kind.Rollback }, bet);
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).balance).toBe('300.00');
    for (const kind of ['REFUND','ROLLBACK']) {
      await invalid(em => insert(em, 'wager_transactions', processedValues(target, {
        kind, amount: '100.00', reference_external_transaction_id: bet.externalTransactionId,
        reference_transaction_id: bet.id, balance: '400.00',
      })), '23505');
    }
    await atomic(em => insert(em, 'wager_transactions', processedValues(target, { kind: 'REFUND',
      status: 'REJECTED', failure_code: 'ALREADY_REVERSED', amount: '100.00',
      reference_external_transaction_id: bet.externalTransactionId, balance: '300.00' })));
  });
  test('ROLLBACK of REFUND debits the exact referenced credit', async () => {
    const target = await open();
    const bet = await apply(target);
    const refund = await apply(target, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }, bet);
    const rollback = await apply(target, { kind: Kind.Rollback, referenceExternalTransactionId: refund.externalTransactionId }, refund);
    const entry = await fresh().findOneOrFail(LedgerEntryRecord, { transactionId: rollback.id });
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter).toBe('90.00');
  });
  test.each(['provider_id','player_id','wallet_id','currency','round_id','reference_external_transaction_id'])('rejects SQL reference context mismatch in %s', async field => {
    const target = await open();
    const bet = await apply(target);
    const other = await open();
    await invalid(async em => {
      const tx = processedValues(target, {
        kind: 'REFUND', reference_external_transaction_id: bet.externalTransactionId,
        reference_transaction_id: bet.id, balance: '100.00',
        ...(field === 'wallet_id' ? { wallet_id: other.id, player_id: other.playerId } :
          field === 'player_id' ? { player_id: other.playerId } : { [field]: field === 'currency' ? 'USD' : 'wrong' }),
      });
      await insert(em, 'wager_transactions', tx);
      // Isolate the deferred FK check before financial correspondence triggers.
      await em.execute('SET CONSTRAINTS transactions_reference_fk IMMEDIATE');
    }, '23503');
  });
  test('rejects processed reversals with wrong amount, reference kind or pending reference', async () => {
    for (const mismatch of ['amount','kind','status']) {
      const target = await open();
      const reference = mismatch === 'status' ? WagerTransaction.create(props(target))
        : await apply(target, mismatch === 'kind' ? { kind: Kind.Win } : {});
      if (mismatch === 'status') await atomic(async em => { em.persist(transactionMapper.toRecord(reference)); await em.flush(); });
      await invalid(async em => {
        const amount = mismatch === 'amount' ? '9.00' : '10.00';
        const after = target.balance.add(money(amount)).toString();
        const tx = processedValues(target, { kind: 'REFUND', amount,
          balance: after, reference_external_transaction_id: reference.externalTransactionId, reference_transaction_id: reference.id });
        await insert(em, 'wager_transactions', tx);
        await insert(em, 'wallet_ledger_entries', ledgerValues(target, tx.id, { direction: 'CREDIT',
          amount, balance_before: target.balance.toString(), balance_after: after,
          wallet_version: target.version + 1 }));
        await em.execute('UPDATE wallets SET balance=?,version=? WHERE id=?',
          [after, target.version + 1, target.id]);
      });
    }
  });

  test('inbox deduplicates per consumer and preserves original hash and completion', async () => {
    const messageId = randomUUID();
    const values = { message_id: messageId, consumer_name: 'consumer', payload_hash: 'hash', received_at: at };
    await atomic(em => insert(em, 'inbox_messages', values));
    await invalid(em => insert(em, 'inbox_messages', values), '23505');
    await atomic(em => insert(em, 'inbox_messages', { ...values, consumer_name: 'other-consumer' }));
    await invalid(em => em.execute("UPDATE inbox_messages SET payload_hash='other' WHERE message_id=?", [messageId]));
    await sql('UPDATE inbox_messages SET processed_at=? WHERE message_id=?', [at, messageId]);
    await invalid(em => em.execute('UPDATE inbox_messages SET processed_at=NULL WHERE message_id=?', [messageId]));
    expect(await fresh().count(InboxMessageRecord, { messageId })).toBe(2);
  });
  test('outbox preserves event identity and enforces lease, attempts and publication shape', async () => {
    const target = await open();
    const tx = await apply(target);
    const entry = ledgerMapper.toDomain(await fresh().findOneOrFail(LedgerEntryRecord, { transactionId: tx.id }));
    const event = WalletBalanceChanged.from(target, entry, { eventId: randomUUID(), correlationId: randomUUID(), occurredAt: at });
    const record = outboxRecord(event);
    await atomic(async em => { em.persist(record); await em.flush(); });
    expect((await fresh().findOneOrFail(OutboxMessageRecord, record.id)).payload).toEqual({ ...event.toJSON() });
    await invalid(async em => { em.persist(outboxRecord(event)); await em.flush(); }, '23505');
    await invalid(em => em.execute("UPDATE outbox_messages SET payload='{}' WHERE id=?", [record.id]));
    await invalid(em => em.execute('UPDATE outbox_messages SET attempts=-1 WHERE id=?', [record.id]));
    await invalid(em => em.execute("UPDATE outbox_messages SET lease_token='token' WHERE id=?", [record.id]));
    await sql("UPDATE outbox_messages SET attempts=1,lease_token='token',lease_until=now()+interval '30 seconds' WHERE id=?", [record.id]);
    await invalid(em => em.execute('UPDATE outbox_messages SET published_at=now() WHERE id=?', [record.id]));
    await sql('UPDATE outbox_messages SET published_at=now(),lease_token=NULL,lease_until=NULL WHERE id=?', [record.id]);
    await invalid(em => em.execute('UPDATE outbox_messages SET published_at=NULL WHERE id=?', [record.id]));
  });
  test('work queues and ledger have the planned partial and cursor indexes', async () => {
    const rows = await sql("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public'");
    for (const name of ['transactions_processed_reversal_unique','transactions_pending_reference_idx',
      'outbox_due_idx','outbox_lease_idx','ledger_wallet_cursor_idx','inbox_received_idx']) {
      expect(rows.some(row => row.indexname === name)).toBe(true);
    }
    expect(rows.find(row => row.indexname === 'outbox_due_idx')!.indexdef).toContain('WHERE (published_at IS NULL)');
  });
  test.each(['before-ledger','before-outbox','before-commit'])('rolls back wallet, transaction, ledger, inbox and outbox together: %s', async failurePoint => {
    const target = await open();
    const tx = WagerTransaction.create(props(target));
    const entry = tx.process(target, { at, ledgerEntryId: randomUUID(), priorReversals: [] })!;
    const event = WalletBalanceChanged.from(target, entry, { eventId: randomUUID(), correlationId: randomUUID(), occurredAt: at });
    const messageId = randomUUID();
    await expect(atomic(async em => {
      await insert(em, 'inbox_messages', { message_id: messageId, consumer_name: 'consumer', payload_hash: 'hash', received_at: at });
      await em.execute('UPDATE wallets SET balance=?,version=? WHERE id=?', [target.balance.toString(), target.version, target.id]);
      em.persist(transactionMapper.toRecord(tx)); await em.flush();
      if (failurePoint === 'before-ledger') throw new Error('injected failure');
      em.persist(ledgerMapper.toRecord(entry)); await em.flush();
      if (failurePoint === 'before-outbox') throw new Error('injected failure');
      em.persist(outboxRecord(event)); await em.flush();
      await em.execute('UPDATE inbox_messages SET processed_at=? WHERE message_id=?', [at, messageId]);
      throw new Error('injected failure');
    })).rejects.toThrow('injected failure');
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).balance).toBe('100.00');
    expect(await fresh().count(WagerTransactionRecord, { id: tx.id })).toBe(0);
    expect(await fresh().count(LedgerEntryRecord, { transactionId: tx.id })).toBe(0);
    expect(await fresh().count(InboxMessageRecord, { messageId })).toBe(0);
    expect(await fresh().count(OutboxMessageRecord, { id: event.eventId })).toBe(0);
  });
  test('commits wallet, transaction, ledger, inbox and stable event envelope atomically', async () => {
    const target = await open();
    const tx = WagerTransaction.create(props(target));
    const entry = tx.process(target, { at, ledgerEntryId: randomUUID(), priorReversals: [] })!;
    const event = WalletBalanceChanged.from(target, entry, { eventId: randomUUID(), correlationId: randomUUID(), occurredAt: at });
    const messageId = randomUUID();
    await atomic(async em => {
      await insert(em, 'inbox_messages', { message_id: messageId, consumer_name: 'consumer', payload_hash: 'hash', received_at: at, processed_at: at });
      await em.execute('UPDATE wallets SET balance=?,version=? WHERE id=?', [target.balance.toString(), target.version, target.id]);
      em.persist([transactionMapper.toRecord(tx), ledgerMapper.toRecord(entry), outboxRecord(event)]);
      await em.flush();
    });
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).balance).toBe('90.00');
    expect(await fresh().count(LedgerEntryRecord, { transactionId: tx.id })).toBe(1);
    expect((await fresh().findOneOrFail(InboxMessageRecord, { messageId, consumerName: 'consumer' })).processedAt).toEqual(at);
    expect((await fresh().findOneOrFail(OutboxMessageRecord, { id: event.eventId })).publishedAt).toBeNull();
  });
  test('two SQL writers cannot overwrite the same financial wallet version', async () => {
    const target = await open();
    let signal!: () => void;
    const inserted = new Promise<void>(resolve => { signal = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const first = atomic(async em => {
      const tx = processedValues(target);
      await em.execute('UPDATE wallets SET balance=90,version=2 WHERE id=?', [target.id]);
      await insert(em, 'wager_transactions', tx);
      await insert(em, 'wallet_ledger_entries', ledgerValues(target, tx.id));
      signal(); await barrier;
    });
    await inserted;
    const second = atomic(async em => {
      const tx = processedValues(target);
      await insert(em, 'wager_transactions', tx);
      await insert(em, 'wallet_ledger_entries', ledgerValues(target, tx.id));
      await em.execute('UPDATE wallets SET balance=90,version=2 WHERE id=?', [target.id]);
    });
    release();
    const results = await Promise.allSettled([first, second]);
    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('rejected');
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).balance).toBe('90.00');
    expect(await fresh().count(LedgerEntryRecord, { walletId: target.id })).toBe(2);
  });
  test('rolls every migration down then up in the disposable database only', async () => {
    await orm.getMigrator().down({ to: 0 });
    const [row] = await sql("SELECT to_regclass('public.wallets') AS wallets,to_regclass('public.outbox_messages') AS outbox");
    expect(row!.wallets).toBeNull(); expect(row!.outbox).toBeNull();
    expect(await sql("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('wallets','wager_transactions','wallet_ledger_entries','inbox_messages','outbox_messages')")).toHaveLength(0);
    expect(await sql("SELECT proname FROM pg_proc JOIN pg_namespace n ON n.oid=pronamespace WHERE n.nspname='public' AND proname IN ('valid_money','protect_transaction_state','reject_ledger_mutation','protect_wallet_identity','check_wallet_movement','check_ledger_correspondence','check_transaction_correspondence','protect_message_identity')")).toHaveLength(0);
    expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(0);
    await orm.getMigrator().up();
    expect(await orm.getMigrator().getExecutedMigrations()).toHaveLength(4);
    await sql(runtimePrivilegesSql('wager_runtime'));
    const [permissions] = await sql("SELECT has_table_privilege('wager_runtime','wallet_ledger_entries','SELECT') AS readable,has_table_privilege('wager_runtime','wallet_ledger_entries','UPDATE') AS mutable");
    expect(permissions!.readable).toBe(true); expect(permissions!.mutable).toBe(false);
    await open('0.01');
  });
});
