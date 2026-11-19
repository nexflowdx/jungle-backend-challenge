import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { rehydrateMoney } from '../../../database/money-mapping';
import { WalletReconciliationSource, type ReconciliationSummary, type WalletReconciliationSnapshot } from '../application/reconcile-wallet';

/** Aggregate NUMERIC may exceed Money's individual-value bound. No floating point. */
function decimal(value: string): string {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Invalid reconciliation decimal');
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

export class PostgresWalletReconciliationSource extends WalletReconciliationSource {
  constructor(private readonly orm: MikroORM) { super(); }

  override snapshot<T>(work: (snapshot: WalletReconciliationSnapshot) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(async em => {
      // Honor the ORM's trusted schema configuration, including isolated test schemas.
      const table = (name: string) => em.getPlatform().quoteIdentifier(`${this.orm.config.get('schema') ?? 'public'}.${name}`);
      const wallets = table('wallets'); const ledger = table('wallet_ledger_entries'); const transactions = table('wager_transactions');
      return work({
        wallet: async id => {
          const [row] = await em.execute<{ id: string; balance: string; currency: string; version: number }[]>(
            `SELECT id,balance,currency,version FROM ${wallets} WHERE id=?`, [id]);
          return row ? { id: row.id, balance: rehydrateMoney(row.balance, row.currency).toJSON(), version: row.version } : undefined;
        },
        summarize: async wallet => {
          const [row] = await em.execute<{
            initial: string | null; credits: string; debits: string; calculated: string | null; difference: string | null;
            entries: string; invalid: string; sequence_invalid: boolean; missing: string;
          }[]>(`
            WITH ordered AS (
              SELECT e.*, t.kind, t.status, t.wallet_id AS transaction_wallet, t.currency AS transaction_currency,
                t.amount AS transaction_amount, t.balance AS transaction_balance,
                lag(e.wallet_version) OVER (ORDER BY e.wallet_version,e.id) AS previous_version,
                lag(e.balance_after) OVER (ORDER BY e.wallet_version,e.id) AS previous_balance
              FROM ${ledger} e LEFT JOIN ${transactions} t ON t.id=e.transaction_id WHERE e.wallet_id=?
            ), stats AS (
              SELECT count(*) AS entries,
                count(*) FILTER (WHERE kind='OPENING') AS opening_entries,
                count(*) FILTER (WHERE kind='OPENING' AND wallet_version=1 AND direction='CREDIT'
                  AND balance_before=0 AND balance_after=amount AND status='PROCESSED'
                  AND transaction_wallet=? AND transaction_currency=? AND currency=?
                  AND transaction_amount=amount AND transaction_balance=balance_after
                  AND public.valid_money(amount) AND amount>0) AS valid_openings,
                max(amount) FILTER (WHERE kind='OPENING' AND wallet_version=1) AS opening_amount,
                min(wallet_version) AS first_version, max(wallet_version) AS last_version,
                (SELECT balance_before FROM ordered ORDER BY wallet_version,id LIMIT 1) AS first_balance,
                coalesce(sum(amount) FILTER (WHERE direction='CREDIT' AND kind IS DISTINCT FROM 'OPENING'
                  AND public.valid_money(amount) AND currency=?),0) AS credits,
                coalesce(sum(amount) FILTER (WHERE direction='DEBIT' AND kind IS DISTINCT FROM 'OPENING'
                  AND public.valid_money(amount) AND currency=?),0) AS debits,
                count(*) FILTER (WHERE currency<>? OR kind IS NULL OR status<>'PROCESSED' OR kind='LOSS'
                  OR transaction_wallet<>? OR transaction_currency<>currency OR transaction_amount<>amount OR wallet_version<1
                  OR transaction_balance IS DISTINCT FROM balance_after OR direction NOT IN ('CREDIT','DEBIT')
                  OR NOT public.valid_money(amount) OR amount<=0 OR NOT public.valid_money(balance_before)
                  OR NOT public.valid_money(balance_after)
                  OR balance_after<>CASE direction WHEN 'CREDIT' THEN balance_before+amount ELSE balance_before-amount END
                  OR (kind='BET' AND direction<>'DEBIT') OR (kind IN ('OPENING','WIN','REFUND') AND direction<>'CREDIT')) AS invalid,
                coalesce(bool_or(previous_version IS NOT NULL AND
                  (wallet_version<>previous_version+1 OR balance_before<>previous_balance)),false) AS broken_chain
              FROM ordered
            ), evidence AS (
              SELECT stats.*,
                (SELECT count(*) FROM ${transactions} WHERE wallet_id=? AND kind='OPENING') AS opening_transactions,
                (SELECT count(*) FROM ${transactions} t WHERE t.wallet_id=? AND t.status='PROCESSED' AND t.kind<>'LOSS'
                  AND NOT EXISTS (SELECT 1 FROM ${ledger} e WHERE e.wallet_id=t.wallet_id AND e.transaction_id=t.id)) AS missing
              FROM stats
            ), resolved AS (
              SELECT *, CASE
                WHEN opening_transactions=1 AND opening_entries=1 AND valid_openings=1 THEN opening_amount
                WHEN opening_transactions=0 AND opening_entries=0 AND
                  ((entries=0 AND ?=1 AND ?::numeric=0) OR (first_version=2 AND first_balance=0)) THEN 0::numeric
                ELSE NULL END AS initial,
                broken_chain OR (entries>0 AND last_version<>?) AS sequence_invalid
              FROM evidence
            ), calculated AS (
              SELECT *, initial+credits-debits AS calculated FROM resolved
            )
            SELECT initial::text, credits::text, debits::text, calculated::text,
              (?::numeric-calculated)::text AS difference, entries::text, invalid::text, sequence_invalid, missing::text
            FROM calculated`, [wallet.id, wallet.id, wallet.balance.currency, wallet.balance.currency,
            wallet.balance.currency, wallet.balance.currency, wallet.balance.currency, wallet.id, wallet.id, wallet.id, wallet.version, wallet.balance.amount,
            wallet.version, wallet.balance.amount]);
          if (!row) throw new Error('Missing reconciliation aggregate');
          const checkedEntries = Number(row.entries); // Count only, never money.
          if (!Number.isSafeInteger(checkedEntries)) throw new Error('Reconciliation count exceeds safe integer');
          const issues: string[] = [];
          if (row.initial === null) issues.push('INITIAL_BALANCE_UNPROVEN');
          if (row.invalid !== '0') issues.push('INVALID_LEDGER_ENTRIES');
          if (row.sequence_invalid) issues.push('INVALID_LEDGER_SEQUENCE');
          if (row.missing !== '0') issues.push('MISSING_FINANCIAL_ENTRIES');
          const summary: ReconciliationSummary = {
            initialBalance: row.initial === null ? null : decimal(row.initial),
            credits: decimal(row.credits), debits: decimal(row.debits),
            calculatedBalance: issues.length ? null : row.calculated === null ? null : decimal(row.calculated),
            difference: issues.length ? null : row.difference === null ? null : decimal(row.difference),
            checkedEntries, issues,
          };
          return summary;
        },
      });
    }, { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true });
  }
}
