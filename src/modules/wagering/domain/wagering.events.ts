import { DomainError } from '../../../shared/domain/domain-error';
import { IntegrationEvent, type EventContext, type IntegrationEventProps } from '../../../shared/domain/integration-event';
import type { MoneyProps } from '../../../shared/domain/money';
import type { Wallet } from '../../wallets/domain/wallet';
import { WalletBalanceChanged } from '../../wallets/domain/wallet-balance-changed';
import type { WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry';
import type { WagerTransaction } from './wager-transaction';
import { type FailureCode, type WagerTransactionKind, WagerTransactionStatus as Status } from './wager-transaction.types';

export interface WagerTransactionEventData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly status: Status;
  readonly money: MoneyProps;
  readonly balance: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly referenceTransactionId?: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  readonly failureCode: FailureCode;
}

function eventData(transaction: WagerTransaction, status: Status): WagerTransactionEventData {
  if (transaction.status !== status || !transaction.balance) {
    throw new DomainError('INVALID_TRANSACTION_EVENT', 'Event requires the matching transaction state and balance snapshot');
  }
  return {
    transactionId: transaction.id, providerId: transaction.providerId, externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId, playerId: transaction.playerId, roundId: transaction.roundId, gameId: transaction.gameId,
    kind: transaction.kind, status: transaction.status, money: transaction.money.toJSON(), balance: transaction.balance.toJSON(),
    ...(transaction.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
    ...(transaction.referenceTransactionId === undefined ? {} : { referenceTransactionId: transaction.referenceTransactionId }),
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WagerTransactionEventData>) { super(props); Object.freeze(this); }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ ...context, aggregateId: transaction.walletId, data: eventData(transaction, Status.Processed) });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) { super(props); Object.freeze(this); }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    const data = eventData(transaction, Status.Rejected);
    if (!transaction.failureCode) throw new DomainError('INVALID_TRANSACTION_EVENT', 'Rejection requires a failure code');
    return new WagerTransactionRejected({ ...context, aggregateId: transaction.walletId, data: { ...data, failureCode: transaction.failureCode } });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WagerTransactionEventData>) { super(props); Object.freeze(this); }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({ ...context, aggregateId: transaction.walletId, data: eventData(transaction, Status.PendingReference) });
  }
}

export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) { super(props); Object.freeze(this); }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionFailed {
    const data = eventData(transaction, Status.Failed);
    if (!transaction.failureCode) throw new DomainError('INVALID_TRANSACTION_EVENT', 'Failure requires a failure code');
    return new WagerTransactionFailed({ ...context, aggregateId: transaction.walletId, data: { ...data, failureCode: transaction.failureCode } });
  }
}

/** Builds values for the future outbox; never publishes. Contexts supply one stable identity per event. */
export function createTransactionEvents(
  transaction: WagerTransaction, wallet: Wallet, entry: WalletLedgerEntry | undefined, context: () => EventContext,
): readonly IntegrationEvent<unknown>[] {
  const expectsEntry = transaction.status === Status.Processed && transaction.affectsBalance();
  if (expectsEntry !== (entry !== undefined) || wallet.id !== transaction.walletId
    || (entry && (entry.transactionId !== transaction.id || !entry.money.equals(transaction.money)
      || !transaction.balance?.equals(entry.balanceAfter)))) {
    throw new DomainError('INVALID_TRANSACTION_EVENT', 'Ledger entry must match the transaction financial effect');
  }
  let event: IntegrationEvent<unknown>;
  switch (transaction.status) {
    case Status.Processed: event = WagerTransactionProcessed.from(transaction, context()); break;
    case Status.Rejected: event = WagerTransactionRejected.from(transaction, context()); break;
    case Status.Failed: event = WagerTransactionFailed.from(transaction, context()); break;
    case Status.PendingReference: event = WagerTransactionPendingReference.from(transaction, context()); break;
    default: throw new DomainError('INVALID_TRANSACTION_EVENT', 'No integration event defined for this state');
  }
  return Object.freeze(entry ? [event, WalletBalanceChanged.from(wallet, entry, context())] : [event]);
}
