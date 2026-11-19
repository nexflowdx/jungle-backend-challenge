import type { MoneyProps } from '../../../shared/domain/money';
import { assertIdentifier } from '../../../shared/domain/financial-rules';
import { operationalMetrics } from '../../operations/operational-metrics';
import { JsonLogger, jsonLogger } from '../../operations/json-logger';

export interface ReconciliationWallet {
  readonly id: string;
  readonly balance: MoneyProps;
  readonly version: number;
}
export interface ReconciliationSummary {
  readonly initialBalance: string | null;
  /** Credits after opening; OPENING is deliberately excluded. */
  readonly credits: string;
  readonly debits: string;
  readonly calculatedBalance: string | null;
  /** Persisted minus calculated balance. */
  readonly difference: string | null;
  readonly checkedEntries: number;
  readonly issues: readonly string[];
}
export interface WalletReconciliationSnapshot {
  wallet(walletId: string): Promise<ReconciliationWallet | undefined>;
  summarize(wallet: ReconciliationWallet): Promise<ReconciliationSummary>;
}
export abstract class WalletReconciliationSource {
  /** All callback reads must share one REPEATABLE READ READ ONLY transaction. */
  abstract snapshot<T>(work: (snapshot: WalletReconciliationSnapshot) => Promise<T>): Promise<T>;
}
export class ReconciliationWalletNotFoundError extends Error {}

export class ReconcileWallet {
  constructor(private readonly source: WalletReconciliationSource, private readonly logger: JsonLogger = jsonLogger) {}

  execute(walletId: string) {
    assertIdentifier(walletId);
    return this.source.snapshot(async snapshot => {
      const wallet = await snapshot.wallet(walletId);
      if (!wallet) throw new ReconciliationWalletNotFoundError();
      const summary = await snapshot.summarize(wallet);
      const money = (amount: string | null): MoneyProps | null => amount === null ? null : { amount, currency: wallet.balance.currency };
      const conclusive = summary.initialBalance !== null && summary.calculatedBalance !== null
        && summary.difference !== null && summary.issues.length === 0;
      const consistent = conclusive ? summary.difference === '0.00' : null;
      return {
        walletId: wallet.id, currency: wallet.balance.currency,
        storedBalance: wallet.balance, initialBalance: money(summary.initialBalance),
        credits: money(summary.credits)!, debits: money(summary.debits)!,
        calculatedBalance: money(summary.calculatedBalance), difference: money(summary.difference),
        checkedEntries: summary.checkedEntries, consistent,
        status: !conclusive ? 'INCONCLUSIVE' as const : consistent ? 'CONSISTENT' as const : 'DIVERGENT' as const,
        issues: summary.issues,
      };
    }).then(report => {
      operationalMetrics.observeReconciliation(report.status);
      if (report.status === 'DIVERGENT') this.logger.emit('error', 'reconciliation.divergent', { walletId: report.walletId });
      if (report.status === 'INCONCLUSIVE') this.logger.emit('warn', 'reconciliation.inconclusive', { walletId: report.walletId });
      return report;
    });
  }
}
