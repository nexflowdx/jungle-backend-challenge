import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InvalidLedgerQueryError, LedgerWalletNotFoundError, ReadWalletLedger } from '../../src/modules/wallets/application/read-wallet-ledger';
import { PostgresWalletLedgerReader } from '../../src/modules/wallets/infrastructure/postgres-wallet-ledger-reader';
import { PostgresWalletOpeningUnitOfWork } from '../../src/modules/wallets/infrastructure/postgres-wallet-opening-unit-of-work';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { ProcessWagerTransaction } from '../../src/modules/wagering/application/process-wager-transaction';
import { Money } from '../../src/shared/domain/money';
import { LedgerDirection } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import { createHttpApplication } from '../../src/http/http-api.module';
import { openTestWallet, testPersistence, wagerCommand, walletPersistenceSnapshot, type TestWallet } from '../helpers/postgres-wager-fixtures';
import { httpRequest } from '../helpers/http-request';

describe.skipIf(process.env.PERSISTENCE_INTEGRATION !== '1')('wallet ledger keyset with real PostgreSQL (9.1)', () => {
  let orm: MikroORM; let reader: PostgresWalletLedgerReader; let query: ReadWalletLedger;
  beforeAll(async () => {
    orm = await testPersistence(); await orm.getMigrator().up();
    reader = new PostgresWalletLedgerReader(orm); query = new ReadWalletLedger(reader);
  }, 30000);
  afterAll(async () => { await orm?.close(true); });

  // Isolated SQL fixture: INSERT exact microseconds directly, keeping all financial
  // triggers enabled. No UPDATE to the immutable ledger, no Date round-trip.
  async function credit(wallet: TestWallet, id: string, at: string) {
    const tx = randomUUID();
    await orm.em.fork().transactional(async em => {
      const [current] = await em.execute<{ balance: string; version: number }[]>(
        'SELECT balance, version FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
      const previous = Money.from({ amount: current!.balance, currency: wallet.balance.currency });
      const amount = Money.from({ amount: '1.00', currency: wallet.balance.currency });
      const next = previous.add(amount); const version = current!.version + 1;
      await em.execute(`INSERT INTO wager_transactions
        (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,
         kind,amount,currency,status,balance,balance_currency,created_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,'WIN',?,?,'PROCESSED',?,?,?::timestamptz,?::timestamptz)`,
      [tx, 'ledger-fixture', tx, tx, 'ledger-fixture-hash', wallet.id, wallet.playerId, 'round', 'game',
        amount.toString(), amount.currency, next.toString(), next.currency, at, at]);
      await em.execute('UPDATE wallets SET balance=?,version=?,updated_at=?::timestamptz WHERE id=?', [next.toString(), version, at, wallet.id]);
      await em.execute(`INSERT INTO wallet_ledger_entries
        (id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after,wallet_version,created_at)
        VALUES (?,?,?,'CREDIT',?,?,?,?,?,?::timestamptz)`,
      [id, wallet.id, tx, amount.toString(), amount.currency, previous.toString(), next.toString(), version, at]);
    });
  }
  async function seed(timestamps: readonly string[]) {
    const wallet = await openTestWallet(orm, '0.00');
    const ids = timestamps.map((_, index) => `${wallet.id}-${index}`);
    for (let i = 0; i < timestamps.length; i++) await credit(wallet, ids[i]!, timestamps[i]!);
    return { wallet, ids };
  }
  const at = '2026-11-19T12:00:00.123456Z';

  test('positive opening returns exact large money, balances, IDs and currency', async () => {
    const wallet = await openTestWallet(orm, '9007199254740993.01', 'USD');
    const page = await query.execute(wallet.id);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ walletId: wallet.id, direction: 'CREDIT', money: wallet.balance,
      balanceBefore: { amount: '0.00', currency: 'USD' }, balanceAfter: wallet.balance, walletVersion: 1 });
    expect(page.items[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.\d{6}Z$/);
    expect(page.hasNextPage).toBe(false); expect(page.nextCursor).toBeNull();
  });
  test('zero opening is empty, missing wallet is not found', async () => {
    const wallet = await openTestWallet(orm, '0.00');
    expect(await query.execute(wallet.id)).toEqual({ items: [], hasNextPage: false, nextCursor: null });
    await expect(query.execute(randomUUID())).rejects.toBeInstanceOf(LedgerWalletNotFoundError);
  });
  test('multiple pages cover every row once, including an exact-size final page', async () => {
    const { wallet, ids } = await seed([1, 2, 3, 4, 5, 6].map(second => `2026-11-19T12:00:0${second}.000000Z`));
    const seen: string[] = []; let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
      const page = await query.execute(wallet.id, { limit: '2', ...(cursor ? { cursor } : {}) });
      expect(page.items).toHaveLength(2); expect(page.hasNextPage).toBe(pageIndex < 2);
      seen.push(...page.items.map(row => row.id)); cursor = page.nextCursor ?? undefined;
    }
    expect(cursor).toBeUndefined(); expect(seen).toEqual([...ids].reverse()); expect(new Set(seen).size).toBe(6);
  });
  test('equal timestamps use id DESC consistently across page boundaries', async () => {
    const { wallet, ids } = await seed([at, at, at]);
    const first = await query.execute(wallet.id, { limit: '1' });
    const second = await query.execute(wallet.id, { limit: '1', cursor: first.nextCursor });
    const third = await query.execute(wallet.id, { limit: '1', cursor: second.nextCursor });
    expect([first.items[0]!.id, second.items[0]!.id, third.items[0]!.id]).toEqual([...ids].reverse());
    expect(third.hasNextPage).toBe(false); expect(third.nextCursor).toBeNull();
  });
  test('cursor comparison preserves microseconds even when ID order conflicts with timestamp order', async () => {
    const wallet = await openTestWallet(orm, '0.00');
    await credit(wallet, `${wallet.id}-z`, '2026-11-19T09:00:00.123001-03:00');
    await credit(wallet, `${wallet.id}-a`, '2026-11-19T12:00:00.123999Z');
    const first = await query.execute(wallet.id, { limit: '1' });
    expect(first.items[0]!.createdAt).toBe('2026-11-19T12:00:00.123999Z');
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString()) as { createdAt: string };
    expect(decoded.createdAt).toBe('2026-11-19T12:00:00.123999Z');
    const second = await query.execute(wallet.id, { limit: '1', cursor: first.nextCursor });
    expect(second.items[0]!.createdAt).toBe('2026-11-19T12:00:00.123001Z');
    expect(second.items[0]!.id).toBe(`${wallet.id}-z`); expect(second.hasNextPage).toBe(false);
  });
  test('invalid cursor is rejected without changing financial state', async () => {
    const wallet = await openTestWallet(orm); const before = await walletPersistenceSnapshot(orm, wallet);
    await expect(query.execute(wallet.id, { cursor: 'invalid' })).rejects.toBeInstanceOf(InvalidLedgerQueryError);
    expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before);
  });
  test('invalid limits are rejected without changing financial state', async () => {
    const wallet = await openTestWallet(orm); const before = await walletPersistenceSnapshot(orm, wallet);
    for (const limit of ['0', '-1', '201', '1.5', '1e2']) {
      await expect(query.execute(wallet.id, { limit })).rejects.toBeInstanceOf(InvalidLedgerQueryError);
    }
    expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before);
  });
  test('wallet filter and cursor binding prevent cross-wallet leakage, including SQL metacharacters', async () => {
    const { wallet } = await seed([at, at]); const other = await openTestWallet(orm);
    const first = await query.execute(wallet.id, { limit: '1' });
    expect(first.items.every(row => row.walletId === wallet.id)).toBe(true);
    expect((await query.execute(other.id)).items.every(row => row.walletId === other.id)).toBe(true);
    await expect(query.execute(other.id, { cursor: first.nextCursor })).rejects.toBeInstanceOf(InvalidLedgerQueryError);
    await expect(query.execute("' OR 1=1 --")).rejects.toBeInstanceOf(LedgerWalletNotFoundError);
  });
  test('all pages are read-only: wallet, transactions, exact ledger timestamps, outbox and inbox remain unchanged', async () => {
    const wallet = await openTestWallet(orm);
    await new ProcessWagerTransaction(new PostgresWagerProcessingUnitOfWork(orm), undefined,
      { newId: randomUUID, now: () => new Date('2030-01-01T00:00:00Z'), retryDelay: async () => {} }).execute(wagerCommand(wallet),
      { consumerName: 'ledger-read-fixture', messageId: randomUUID(), payloadHash: 'a'.repeat(64) });
    const before = await walletPersistenceSnapshot(orm, wallet);
    const audit = () => orm.em.fork().execute(`SELECT * FROM (
      SELECT 'ledger' AS source, to_jsonb(e) AS data FROM wallet_ledger_entries e WHERE wallet_id=?
      UNION ALL SELECT 'inbox', to_jsonb(i) FROM inbox_messages i) audit ORDER BY source, data::text`, [wallet.id]);
    const auditBefore = await audit();
    const first = await query.execute(wallet.id, { limit: '1' });
    expect(first.items[0]!.direction).toBe(LedgerDirection.Debit); expect(first.items[0]!.money.amount).toBe('25.00');
    expect(first.hasNextPage).toBe(true);
    expect((await query.execute(wallet.id, { limit: '1', cursor: first.nextCursor })).hasNextPage).toBe(false);
    expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before); expect(await audit()).toEqual(auditBefore);
  });
  test('a new row ahead of the cursor does not repeat or skip the original older rows', async () => {
    const { wallet, ids } = await seed([at, at, at]);
    const first = await query.execute(wallet.id, { limit: '1' });
    await credit(wallet, `${wallet.id}-new`, '2026-11-19T12:00:01.000001Z');
    const rest = await query.execute(wallet.id, { cursor: first.nextCursor });
    expect(rest.items.map(row => row.id)).toEqual([ids[1]!, ids[0]!]); expect(rest.hasNextPage).toBe(false);
  });
  test('real HTTP routing requires trusted authorization and rejects another wallet', async () => {
    const wallet = await openTestWallet(orm); const other = await openTestWallet(orm);
    const persistence = { walletOpening: new PostgresWalletOpeningUnitOfWork(orm), wagerProcessing: new PostgresWagerProcessingUnitOfWork(orm), walletLedger: reader };
    const app = await createHttpApplication(persistence, { logger: false }, { canRead: (_, id) => id === wallet.id });
    const denied = await createHttpApplication(persistence, { logger: false });
    try {
      await app.init(); await denied.init();
      const get = (target: typeof app, id: string) => httpRequest(target, `/wallets/${id}/ledger`, undefined, [], undefined, 'GET');
      expect((await get(app, wallet.id)).status).toBe(200);
      expect((await get(app, other.id)).status).toBe(403);
      expect((await get(denied, wallet.id)).status).toBe(403);
    } finally { await app.close(); await denied.close(); }
  });
});
