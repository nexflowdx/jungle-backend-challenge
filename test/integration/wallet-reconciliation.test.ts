import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { EventSubscriber, Transaction } from '@mikro-orm/core';
import { databaseOptions } from '../../src/database/orm';
import { ReconcileWallet, ReconciliationWalletNotFoundError, type WalletReconciliationSource } from '../../src/modules/wallets/application/reconcile-wallet';
import { PostgresWalletReconciliationSource } from '../../src/modules/wallets/infrastructure/postgres-wallet-reconciliation-source';
import { ProcessWagerTransaction } from '../../src/modules/wagering/application/process-wager-transaction';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { WagerTransactionKind as Kind } from '../../src/modules/wagering/domain/wager-transaction.types';
import { openTestWallet, testPersistence, wagerCommand, walletPersistenceSnapshot, type TestWallet } from '../helpers/postgres-wager-fixtures';
import { bounded } from '../helpers/bun-process-client';
import { createHttpApplication } from '../../src/http/http-api.module';
import type { WalletLedgerAccess } from '../../src/http/wallet-ledger-access.guard';
import { PostgresWalletOpeningUnitOfWork } from '../../src/modules/wallets/infrastructure/postgres-wallet-opening-unit-of-work';
import { httpRequest } from '../helpers/http-request';

describe.skipIf(process.env.PERSISTENCE_INTEGRATION !== '1')('wallet reconciliation with real PostgreSQL (9.2)', () => {
  let orm: MikroORM; let fixtureOrm: MikroORM; let source: PostgresWalletReconciliationSource; let service: ReconcileWallet;
  const fixtureSchema = `reconciliation_fixture_${randomUUID().replaceAll('-', '')}`;
  let inspect = false; let settings: unknown; let transactionContext: Transaction | undefined;
  beforeAll(async () => {
    orm = await testPersistence(); await orm.getMigrator().up();
    source = new PostgresWalletReconciliationSource(orm); service = new ReconcileWallet(source);
    const inspector: EventSubscriber = { afterTransactionStart: async args => {
      if (!inspect) return;
      transactionContext = args.transaction;
      const connection = orm.em.getConnection();
      settings = await connection.execute(`SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only') AS readonly`, [], 'all', args.transaction);
    } };
    orm.em.getEventManager().registerSubscriber(inspector);
    // These are separate, deliberately unconstrained fixture tables. LIKE without
    // INCLUDING CONSTRAINTS copies no CHECK, FK, unique index or trigger. The
    // public financial tables/protections are never altered or disabled.
    await orm.em.fork().execute(`CREATE SCHEMA "${fixtureSchema}"`);
    for (const table of ['wallets', 'wager_transactions', 'wallet_ledger_entries']) {
      await orm.em.fork().execute(`CREATE TABLE "${fixtureSchema}".${table} (LIKE public.${table} INCLUDING DEFAULTS)`);
    }
    fixtureOrm = await MikroORM.init({ ...databaseOptions({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test',
      user: 'diagnostic', password: process.env.PGPASSWORD! }), schema: fixtureSchema });
  }, 30000);
  afterAll(async () => {
    await fixtureOrm?.close(true);
    if (orm) { await orm.em.fork().execute(`DROP SCHEMA IF EXISTS "${fixtureSchema}" CASCADE`); await orm.close(true); }
  });
  const processWager = async (wallet: TestWallet, kind: Kind.Bet | Kind.Win, amount: string) => {
    return new ProcessWagerTransaction(new PostgresWagerProcessingUnitOfWork(orm))
      .execute(wagerCommand(wallet, kind, { money: { amount, currency: wallet.balance.currency } }));
  };
  async function clone(wallet: TestWallet) {
    for (const table of ['wallets', 'wager_transactions', 'wallet_ledger_entries']) {
      await orm.em.fork().execute(`INSERT INTO "${fixtureSchema}".${table} SELECT * FROM public.${table} WHERE ${table === 'wallets' ? 'id' : 'wallet_id'}=?`, [wallet.id]);
    }
    return new ReconcileWallet(new PostgresWalletReconciliationSource(fixtureOrm));
  }
  async function http(sourceOrm: MikroORM, access?: WalletLedgerAccess, reconciliation?: WalletReconciliationSource) {
    const app = await createHttpApplication({ walletOpening: new PostgresWalletOpeningUnitOfWork(orm),
      wagerProcessing: new PostgresWagerProcessingUnitOfWork(orm),
      walletReconciliation: reconciliation ?? new PostgresWalletReconciliationSource(sourceOrm) }, { logger: false }, access);
    await app.init(); return app;
  }
  const post = (app: Awaited<ReturnType<typeof http>>, id: string) => httpRequest(app, `/wallets/${id}/reconciliation`, undefined);

  test('HTTP preserves consistent contract, requires wallet authorization before lookup and leaves financial records unchanged', async () => {
    const wallet = await openTestWallet(orm, '9007199254740993.01', 'USD'); const missing = randomUUID();
    const before = await walletPersistenceSnapshot(orm, wallet); let reads = 0;
    const tracked: WalletReconciliationSource = { snapshot: work => { reads++; return source.snapshot(work); } };
    const denied = await http(orm, undefined, tracked);
    const authorized = await http(orm, { canRead: (_, id) => id === wallet.id || id === missing }, tracked);
    try {
      expect((await post(denied, wallet.id)).status).toBe(403);
      expect((await post(denied, missing)).status).toBe(403);
      expect((await post(authorized, randomUUID())).status).toBe(403); expect(reads).toBe(0);
      expect(await post(authorized, wallet.id)).toMatchObject({ status: 200, body: { walletId: wallet.id,
        storedBalance: wallet.balance, calculatedBalance: wallet.balance, difference: { amount: '0.00', currency: 'USD' },
        status: 'CONSISTENT', consistent: true, checkedEntries: 1 } });
      expect(await post(authorized, missing)).toEqual({ status: 404, body: { code: 'WALLET_NOT_FOUND', message: 'Wallet not found' } });
      expect(reads).toBe(2); expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before);
    } finally { await denied.close(); await authorized.close(); }
  });
  test('HTTP reports isolated financial divergence as 200 without changing public data', async () => {
    const wallet = await openTestWallet(orm); const before = await walletPersistenceSnapshot(orm, wallet); await clone(wallet);
    await fixtureOrm.em.fork().execute(`UPDATE "${fixtureSchema}".wallets SET balance=99.99 WHERE id=?`, [wallet.id]);
    const app = await http(fixtureOrm, { canRead: (_, id) => id === wallet.id });
    try {
      expect(await post(app, wallet.id)).toMatchObject({ status: 200, body: { status: 'DIVERGENT', consistent: false,
        storedBalance: { amount: '99.99' }, calculatedBalance: { amount: '100.00' }, difference: { amount: '-0.01' }, checkedEntries: 1 } });
      expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before);
    } finally { await app.close(); }
  });
  test('HTTP returns null consistency and calculated values when isolated opening evidence is missing', async () => {
    const wallet = await openTestWallet(orm); const before = await walletPersistenceSnapshot(orm, wallet); await clone(wallet);
    await fixtureOrm.em.fork().execute(`DELETE FROM "${fixtureSchema}".wallet_ledger_entries WHERE wallet_id=?`, [wallet.id]);
    await fixtureOrm.em.fork().execute(`DELETE FROM "${fixtureSchema}".wager_transactions WHERE wallet_id=?`, [wallet.id]);
    const app = await http(fixtureOrm, { canRead: (_, id) => id === wallet.id });
    try {
      expect(await post(app, wallet.id)).toMatchObject({ status: 200, body: { status: 'INCONCLUSIVE', consistent: null,
        calculatedBalance: null, difference: null, checkedEntries: 0, issues: ['INITIAL_BALANCE_UNPROVEN'] } });
      expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before);
    } finally { await app.close(); }
  });
  test('HTTP sanitizes a real PostgreSQL relation error instead of returning financial divergence', async () => {
    const broken = await MikroORM.init({ ...databaseOptions({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test',
      user: 'diagnostic', password: process.env.PGPASSWORD! }), schema: `missing_http_${randomUUID().replaceAll('-', '')}` });
    const app = await http(broken, { canRead: () => true });
    try {
      expect(await post(app, randomUUID())).toEqual({ status: 500, body: { code: 'INTERNAL_ERROR', message: 'Unable to process request' } });
    } finally { await app.close(); await broken.close(true); }
  });

  test('positive opening is counted exactly once with zero later credits', async () => {
    const wallet = await openTestWallet(orm, '123.45');
    expect(await service.execute(wallet.id)).toMatchObject({ status: 'CONSISTENT', consistent: true, currency: 'BRL', checkedEntries: 1,
      initialBalance: { amount: '123.45' }, credits: { amount: '0.00' }, debits: { amount: '0.00' },
      storedBalance: { amount: '123.45' }, calculatedBalance: { amount: '123.45' }, difference: { amount: '0.00' }, issues: [] });
  });
  test('zero version-one wallet without entries is reliable evidence of zero opening', async () => {
    const wallet = await openTestWallet(orm, '0.00');
    expect(await service.execute(wallet.id)).toMatchObject({ status: 'CONSISTENT', initialBalance: { amount: '0.00' }, checkedEntries: 0 });
  });
  test('zero opening remains provable after a first version-two movement', async () => {
    const wallet = await openTestWallet(orm, '0.00'); await processWager(wallet, Kind.Win, '0.03');
    expect(await service.execute(wallet.id)).toMatchObject({ status: 'CONSISTENT', initialBalance: { amount: '0.00' },
      credits: { amount: '0.03' }, calculatedBalance: { amount: '0.03' }, checkedEntries: 1 });
  });
  test('credits and debits reconcile exactly including values beyond safe Number precision', async () => {
    const wallet = await openTestWallet(orm, '9007199254740993.01', 'USD');
    await processWager(wallet, Kind.Win, '0.02'); await processWager(wallet, Kind.Bet, '0.01');
    expect(await service.execute(wallet.id)).toMatchObject({ status: 'CONSISTENT', currency: 'USD', checkedEntries: 3,
      initialBalance: { amount: '9007199254740993.01' }, credits: { amount: '0.02' }, debits: { amount: '0.01' },
      calculatedBalance: { amount: '9007199254740993.02' }, difference: { amount: '0.00' } });
  });
  test('cumulative credits exceed Money bounds without overflow or rounding', async () => {
    const wallet = await openTestWallet(orm, '0.00'); const amount = '92233720368547758.07';
    await processWager(wallet, Kind.Win, amount); await processWager(wallet, Kind.Bet, amount); await processWager(wallet, Kind.Win, amount);
    expect(await service.execute(wallet.id)).toMatchObject({ status: 'CONSISTENT', credits: { amount: '184467440737095516.14' },
      debits: { amount }, calculatedBalance: { amount } });
  });
  test('wallet filter isolates different currencies and rejects missing wallets', async () => {
    const first = await openTestWallet(orm, '10.00'); const second = await openTestWallet(orm, '20.00', 'USD');
    expect(await service.execute(first.id)).toMatchObject({ walletId: first.id, currency: 'BRL', calculatedBalance: { amount: '10.00' }, checkedEntries: 1 });
    expect(await service.execute(second.id)).toMatchObject({ walletId: second.id, currency: 'USD', calculatedBalance: { amount: '20.00' }, checkedEntries: 1 });
    await expect(service.execute("' OR 1=1 --")).rejects.toBeInstanceOf(ReconciliationWalletNotFoundError);
  });
  test('a committed concurrent movement is invisible to the established snapshot and does not block the writer', async () => {
    const wallet = await openTestWallet(orm);
    let observed!: () => void; let release!: () => void;
    const readWallet = new Promise<void>(resolve => { observed = resolve; }); const resume = new Promise<void>(resolve => { release = resolve; });
    const paused = new ReconcileWallet({ snapshot: work => source.snapshot(scope => work({
      ...scope, wallet: async id => { const row = await scope.wallet(id); observed(); await resume; return row; },
    })) });
    const reading = paused.execute(wallet.id); void reading.catch(() => {});
    try { await bounded(readWallet, 5000, 'wallet snapshot'); await bounded(processWager(wallet, Kind.Bet, '25.00'), 5000, 'unblocked writer'); }
    finally { release(); }
    expect(await bounded(reading, 5000, 'snapshot report')).toMatchObject({ status: 'CONSISTENT', storedBalance: { amount: '100.00' }, calculatedBalance: { amount: '100.00' }, checkedEntries: 1 });
    expect(await service.execute(wallet.id)).toMatchObject({ status: 'CONSISTENT', storedBalance: { amount: '75.00' }, calculatedBalance: { amount: '75.00' }, checkedEntries: 2 });
  });
  test('PostgreSQL reports repeatable read and read only; a write attempt is rejected by the database', async () => {
    const wallet = await openTestWallet(orm); inspect = true;
    try {
      await service.execute(wallet.id);
      expect(settings).toEqual([{ isolation: 'repeatable read', readonly: 'on' }]);
      await expect(source.snapshot(async () => {
        await orm.em.getConnection().execute('UPDATE public.wallets SET balance=balance WHERE false', [], 'all', transactionContext);
      })).rejects.toMatchObject({ code: '25006' });
    } finally { inspect = false; }
    expect((await service.execute(wallet.id)).status).toBe('CONSISTENT');
  });
  test('reconciliation leaves wallet, transactions, ledger and outbox unchanged', async () => {
    const wallet = await openTestWallet(orm); await processWager(wallet, Kind.Bet, '0.01');
    const before = await walletPersistenceSnapshot(orm, wallet);
    expect((await service.execute(wallet.id)).status).toBe('CONSISTENT');
    expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before);
  });
  test('isolated divergent fixture reports signed difference while public integrity remains enforced', async () => {
    const wallet = await openTestWallet(orm); const before = await walletPersistenceSnapshot(orm, wallet); const fixture = await clone(wallet);
    // Raw SQL is qualified: ORM schema configuration does not change search_path.
    await fixtureOrm.em.fork().execute(`UPDATE "${fixtureSchema}".wallets SET balance=99.99 WHERE id=?`, [wallet.id]);
    expect(await fixture.execute(wallet.id)).toMatchObject({ status: 'DIVERGENT', consistent: false,
      calculatedBalance: { amount: '100.00' }, storedBalance: { amount: '99.99' }, difference: { amount: '-0.01' } });
    await expect(orm.em.fork().transactional(em => em.execute('UPDATE public.wallets SET balance=99.99 WHERE id=?', [wallet.id])))
      .rejects.toMatchObject({ code: '23514' });
    expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before);
  });
  test('missing opening evidence is inconclusive instead of assuming zero', async () => {
    const wallet = await openTestWallet(orm); const fixture = await clone(wallet);
    await fixtureOrm.em.fork().execute(`DELETE FROM "${fixtureSchema}".wallet_ledger_entries WHERE wallet_id=?`, [wallet.id]);
    await fixtureOrm.em.fork().execute(`DELETE FROM "${fixtureSchema}".wager_transactions WHERE wallet_id=?`, [wallet.id]);
    expect(await fixture.execute(wallet.id)).toMatchObject({ status: 'INCONCLUSIVE', initialBalance: null,
      calculatedBalance: null, difference: null, consistent: null, issues: ['INITIAL_BALANCE_UNPROVEN'] });
  });
  test('isolated currency and chain inconsistencies cannot return a consistent report', async () => {
    const wallet = await openTestWallet(orm); await processWager(wallet, Kind.Win, '1.00'); const fixture = await clone(wallet);
    await fixtureOrm.em.fork().execute(`UPDATE "${fixtureSchema}".wallet_ledger_entries SET currency='USD',wallet_version=4 WHERE wallet_id=? AND wallet_version=2`, [wallet.id]);
    const report = await fixture.execute(wallet.id);
    expect(report.status).toBe('INCONCLUSIVE'); expect(report.issues).toContain('INVALID_LEDGER_ENTRIES');
    expect(report.issues).toContain('INVALID_LEDGER_SEQUENCE'); expect(report.calculatedBalance).toBeNull();
  });
  test('database relation failure propagates as infrastructure error, never as financial divergence', async () => {
    const wallet = await openTestWallet(orm); await clone(wallet);
    const brokenSchema = `reconciliation_missing_${randomUUID().replaceAll('-', '')}`;
    const broken = await MikroORM.init({ ...databaseOptions({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test',
      user: 'diagnostic', password: process.env.PGPASSWORD! }), schema: brokenSchema });
    try { await expect(new ReconcileWallet(new PostgresWalletReconciliationSource(broken)).execute(wallet.id)).rejects.toMatchObject({ code: '42P01' }); }
    finally { await broken.close(true); }
  });
});
