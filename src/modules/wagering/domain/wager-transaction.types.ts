import type { Money } from '../../../shared/domain/money';
import { DomainError } from '../../../shared/domain/domain-error';

export enum WagerTransactionKind {
  Opening = 'OPENING', Bet = 'BET', Win = 'WIN', Loss = 'LOSS', Refund = 'REFUND', Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', PendingReference = 'PENDING_REFERENCE', Processed = 'PROCESSED',
  Rejected = 'REJECTED', Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletMismatch = 'WALLET_MISMATCH',
  AmountLimitExceeded = 'AMOUNT_LIMIT_EXCEEDED',
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  ReferenceKindInvalid = 'REFERENCE_KIND_INVALID',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceRejected = 'REFERENCE_REJECTED',
  ReferenceFailed = 'REFERENCE_FAILED',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  SelfReference = 'SELF_REFERENCE',
  AlreadyReversed = 'ALREADY_REVERSED',
  PermanentInfrastructureFailure = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}

export class InvalidTransactionStateError extends DomainError {
  constructor() { super('INVALID_TRANSACTION_STATE', 'Transaction cannot perform this transition in its current state'); }
}

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly acceptedBalance?: Money;
  readonly balance?: Money;
  readonly completedAt?: Date;
}
