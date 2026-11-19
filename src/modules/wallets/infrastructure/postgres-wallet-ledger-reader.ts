import type { MikroORM } from '@mikro-orm/postgresql';
import { WalletRecord, type LedgerEntryRecord } from '../../../database/entities';
import { rehydrateMoney } from '../../../database/money-mapping';
import { WalletLedgerReader, type LedgerPosition } from '../application/read-wallet-ledger';

export class PostgresWalletLedgerReader extends WalletLedgerReader {
  constructor(private readonly orm: MikroORM) { super(); }

  override async read(walletId: string, limit: number, before?: LedgerPosition) {
    const em = this.orm.em.fork();
    if (!await em.findOne(WalletRecord, walletId, { fields: ['id'] })) return undefined;
    // Do not hydrate created_at as Date: the driver would discard microseconds.
    const rows = await em.execute<(Omit<LedgerEntryRecord, 'createdAt'> & { createdAt: string })[]>(`
      SELECT id, wallet_id AS "walletId", transaction_id AS "transactionId", direction,
        amount, currency, balance_before AS "balanceBefore", balance_after AS "balanceAfter",
        wallet_version AS "walletVersion",
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
      FROM wallet_ledger_entries
      WHERE wallet_id = ? ${before ? 'AND (created_at, id) < (?::timestamptz, ?::text)' : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    before ? [walletId, before.createdAt, before.id, limit] : [walletId, limit]);
    return rows.map(row => ({
      id: row.id, walletId: row.walletId, transactionId: row.transactionId, direction: row.direction,
      money: rehydrateMoney(row.amount, row.currency).toJSON(),
      balanceBefore: rehydrateMoney(row.balanceBefore, row.currency).toJSON(),
      balanceAfter: rehydrateMoney(row.balanceAfter, row.currency).toJSON(),
      walletVersion: row.walletVersion, createdAt: row.createdAt,
    }));
  }
}
