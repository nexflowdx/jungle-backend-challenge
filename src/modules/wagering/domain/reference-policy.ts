import { DomainError } from '../../../shared/domain/domain-error';
import { LedgerDirection } from '../../wallets/domain/wallet-ledger-entry';
import type { WagerTransaction } from './wager-transaction';
import { FailureCode, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from './wager-transaction.types';

export type ReferenceResolution =
  | { readonly pending: true }
  | { readonly pending: false; readonly referenceTransactionId?: string; readonly direction?: LedgerDirection };

/** Pure policy. The application must load references/reversals under the wallet's database lock. */
export class ReferencePolicy {
  private constructor() {}

  static resolve(
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    priorReversals: readonly WagerTransaction[],
  ): ReferenceResolution {
    const externalReference = transaction.referenceExternalTransactionId;
    if (externalReference === undefined) {
      if (transaction.requiresReference()) throw new DomainError('REFERENCE_REQUIRED', 'Reversal requires a reference');
      return { pending: false, ...ReferencePolicy.direction(transaction.kind) };
    }
    if (externalReference === transaction.externalTransactionId) {
      throw new DomainError(FailureCode.SelfReference, 'Transaction cannot reference itself');
    }
    if (!reference) return { pending: true };

    if (reference.providerId !== transaction.providerId || reference.externalTransactionId !== externalReference
      || reference.playerId !== transaction.playerId || reference.walletId !== transaction.walletId
      || reference.money.currency !== transaction.money.currency || reference.roundId !== transaction.roundId) {
      throw new DomainError(FailureCode.ReferenceContextMismatch, 'Reference must have the same financial context');
    }
    const allowed = transaction.kind === Kind.Rollback ? [Kind.Bet, Kind.Win, Kind.Refund]
      : transaction.kind === Kind.Refund || transaction.kind === Kind.Win ? [Kind.Bet] : undefined;
    if (allowed && !allowed.includes(reference.kind)) {
      throw new DomainError(FailureCode.ReferenceKindInvalid, 'Reference kind is not allowed');
    }
    if (transaction.requiresReference() && !transaction.money.equals(reference.money)) {
      throw new DomainError(FailureCode.ReferenceAmountMismatch, 'Reversal must match the full reference amount');
    }
    if (reference.status === Status.Rejected) {
      throw new DomainError(FailureCode.ReferenceRejected, 'Reference was rejected');
    }
    if (reference.status === Status.Failed) {
      throw new DomainError(FailureCode.ReferenceFailed, 'Reference failed permanently');
    }
    if (reference.status !== Status.Processed) return { pending: true };

    if (transaction.requiresReference() && priorReversals.some((previous) =>
      previous.status === Status.Processed && previous.kind === transaction.kind
      && previous.providerId === reference.providerId
      && (previous.referenceTransactionId === reference.id
        || previous.referenceExternalTransactionId === reference.externalTransactionId))) {
      throw new DomainError(FailureCode.AlreadyReversed, 'Reference already reversed by this operation type');
    }
    return {
      pending: false, referenceTransactionId: reference.id,
      ...(transaction.kind === Kind.Rollback
        ? { direction: reference.kind === Kind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit }
        : ReferencePolicy.direction(transaction.kind)),
    };
  }

  private static direction(kind: Kind): { direction?: LedgerDirection } {
    switch (kind) {
      case Kind.Loss: return {};
      case Kind.Bet: return { direction: LedgerDirection.Debit };
      case Kind.Opening:
      case Kind.Win:
      case Kind.Refund: return { direction: LedgerDirection.Credit };
      case Kind.Rollback: throw new DomainError('REFERENCE_REQUIRED', 'Rollback requires a reference');
    }
  }
}
