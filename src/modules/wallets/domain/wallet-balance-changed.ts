import { DomainError } from '../../../shared/domain/domain-error';
import { IntegrationEvent, type EventContext, type IntegrationEventProps } from '../../../shared/domain/integration-event';
import type { MoneyProps } from '../../../shared/domain/money';
import type { Wallet } from './wallet';
import type { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) { super(props); Object.freeze(this); }

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id || entry.walletVersion !== wallet.version
      || !entry.balanceAfter.equals(wallet.balance) || !entry.money.isPositive() || !entry.isBalanced()) {
      throw new DomainError('INVALID_BALANCE_EVENT', 'Balance event must describe the current wallet movement');
    }
    return new WalletBalanceChanged({
      ...context, aggregateId: wallet.id,
      data: {
        walletId: wallet.id, transactionId: entry.transactionId, direction: entry.direction,
        money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
