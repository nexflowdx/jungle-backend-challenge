import { DomainError } from '../../../shared/domain/domain-error';
import { assertIdentifier, timestamp } from '../../../shared/domain/financial-rules';
import type { Money } from '../../../shared/domain/money';
import { CurrencyMismatchError } from '../../../shared/domain/money.errors';
import { LedgerDirection, type WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry';
import type { Wallet } from '../../wallets/domain/wallet';
import { ReferencePolicy } from './reference-policy';
import {
  type CreateWagerTransactionProps, FailureCode, InvalidTransactionStateError,
  WagerTransactionKind as Kind, WagerTransactionStatus as Status, type WagerTransactionState,
} from './wager-transaction.types';

export interface ProcessTransactionContext {
  readonly at: Date;
  readonly ledgerEntryId?: string;
  readonly reference?: WagerTransaction;
  /** Persisted reversals, loaded by the caller; this is not an in-memory idempotency guarantee. */
  readonly priorReversals: readonly WagerTransaction[];
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: Kind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly #createdAt: number;
  #status: Status;
  #referenceTransactionId: string | undefined;
  #failureCode: FailureCode | undefined;
  #acceptedBalance: Money | undefined;
  #balance: Money | undefined;
  #completedAt: number | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.#createdAt = timestamp(state.createdAt);
    this.#status = state.status;
    this.#referenceTransactionId = state.referenceTransactionId;
    this.#failureCode = state.failureCode;
    this.#acceptedBalance = state.acceptedBalance;
    this.#balance = state.balance;
    this.#completedAt = state.completedAt === undefined ? undefined : timestamp(state.completedAt);
    Object.freeze(this);
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === Kind.Opening) throw new DomainError('INTERNAL_OPERATION_ONLY', 'OPENING is an internal operation');
    return WagerTransaction.createPending(props);
  }

  static createOpening(props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>): WagerTransaction {
    return WagerTransaction.createPending({ ...props, kind: Kind.Opening });
  }

  private static createPending(props: CreateWagerTransactionProps): WagerTransaction {
    for (const id of [props.id, props.providerId, props.externalTransactionId, props.idempotencyKey,
      props.payloadHash, props.walletId, props.playerId, props.roundId, props.gameId]) assertIdentifier(id);
    if (!Object.values(Kind).includes(props.kind)) throw new DomainError('INVALID_TRANSACTION_KIND', 'Unknown kind');
    if (props.money.isNegative() || (props.kind !== Kind.Loss && !props.money.isPositive())) {
      throw new DomainError('INVALID_TRANSACTION_AMOUNT', 'Financial operations require positive money; LOSS permits zero');
    }
    if (props.referenceExternalTransactionId !== undefined) assertIdentifier(props.referenceExternalTransactionId);
    if ((props.kind === Kind.Refund || props.kind === Kind.Rollback) && props.referenceExternalTransactionId === undefined) {
      throw new DomainError('REFERENCE_REQUIRED', 'Reversal requires an external reference');
    }
    return new WagerTransaction({ ...props, status: Status.Pending });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction { return new WagerTransaction(state); }

  get createdAt(): Date { return new Date(this.#createdAt); }
  get status(): Status { return this.#status; }
  get referenceTransactionId(): string | undefined { return this.#referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this.#failureCode; }
  get acceptedBalance(): Money | undefined { return this.#acceptedBalance; }
  get balance(): Money | undefined { return this.#balance ?? this.#acceptedBalance; }
  get completedAt(): Date | undefined { return this.#completedAt === undefined ? undefined : new Date(this.#completedAt); }
  get processedAt(): Date | undefined { return this.status === Status.Processed ? this.completedAt : undefined; }

  isTerminal(): boolean { return [Status.Processed, Status.Rejected, Status.Failed].includes(this.status); }
  affectsBalance(): boolean { return this.kind !== Kind.Loss; }
  requiresReference(): boolean { return this.kind === Kind.Refund || this.kind === Kind.Rollback; }
  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    const resolution = ReferencePolicy.resolve(this, reference, []);
    if (resolution.pending) throw new DomainError('REFERENCE_NOT_READY', 'Reference is not yet processed');
    return resolution.direction;
  }

  markPendingReference(balance: Money): void {
    this.assertMutable();
    if (this.referenceExternalTransactionId === undefined) throw new InvalidTransactionStateError();
    this.assertBalance(balance);
    // Retries must preserve the first acceptance snapshot.
    this.#acceptedBalance ??= balance;
    this.#status = Status.PendingReference;
  }

  markProcessed(referenceTransactionId: string | undefined, balance: Money, at: Date): void {
    this.assertMutable();
    if ((this.referenceExternalTransactionId !== undefined) !== (referenceTransactionId !== undefined)) {
      throw new InvalidTransactionStateError();
    }
    if (referenceTransactionId !== undefined) assertIdentifier(referenceTransactionId);
    this.assertBalance(balance);
    const completedAt = timestamp(at);
    this.#status = Status.Processed;
    this.#referenceTransactionId = referenceTransactionId;
    this.#balance = balance;
    this.#completedAt = completedAt;
  }

  reject(code: FailureCode, balance: Money, at: Date): void { this.finish(Status.Rejected, code, balance, at); }
  fail(code: FailureCode, balance: Money, at: Date): void { this.finish(Status.Failed, code, balance, at); }

  /** Domain behavior only: no persistence, IO, retry scheduler or event publication. */
  process(wallet: Wallet, context: ProcessTransactionContext): WalletLedgerEntry | undefined {
    this.assertMutable();
    timestamp(context.at);
    if (this.kind === Kind.Opening) throw new DomainError('INTERNAL_OPERATION_ONLY', 'Opening is completed by wallet creation');
    if (this.affectsBalance()) assertIdentifier(context.ledgerEntryId ?? '');
    if (wallet.id !== this.walletId || wallet.playerId !== this.playerId) {
      throw new DomainError(FailureCode.WalletMismatch, 'Transaction must be routed to its own wallet');
    }
    // A mismatched currency is a business rejection; snapshot remains in the wallet currency.
    if (wallet.currency !== this.money.currency) {
      this.finish(Status.Rejected, FailureCode.CurrencyMismatch, wallet.balance, context.at, false);
      return undefined;
    }
    try {
      const resolution = ReferencePolicy.resolve(this, context.reference, context.priorReversals);
      if (resolution.pending) {
        this.markPendingReference(wallet.balance);
        return undefined;
      }
      if (resolution.referenceTransactionId !== undefined) assertIdentifier(resolution.referenceTransactionId);
      if (resolution.direction === LedgerDirection.Debit && wallet.balance.isLessThan(this.money)) {
        throw new DomainError(this.requiresReference()
          ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds, 'Insufficient funds for transaction');
      }
      const movement = { id: context.ledgerEntryId!, transactionId: this.id, money: this.money, at: context.at };
      const entry = resolution.direction === undefined ? undefined
        : resolution.direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
      this.markProcessed(resolution.referenceTransactionId, wallet.balance, context.at);
      return entry;
    } catch (error) {
      if (!(error instanceof DomainError) || !Object.values(FailureCode).includes(error.code as FailureCode)) throw error;
      this.reject(error.code as FailureCode, wallet.balance, context.at);
      return undefined;
    }
  }

  private finish(status: Status.Rejected | Status.Failed, code: FailureCode, balance: Money, at: Date, sameCurrency = true): void {
    this.assertMutable();
    if (!Object.values(FailureCode).includes(code)) throw new DomainError('INVALID_FAILURE_CODE', 'Unknown failure code');
    if (sameCurrency) this.assertBalance(balance);
    else if (balance.isNegative()) throw new DomainError('INVALID_WALLET_BALANCE', 'Result balance cannot be negative');
    const completedAt = timestamp(at);
    this.#status = status;
    this.#failureCode = code;
    this.#balance = balance;
    this.#completedAt = completedAt;
  }

  private assertMutable(): void { if (this.isTerminal()) throw new InvalidTransactionStateError(); }
  private assertBalance(balance: Money): void {
    if (balance.currency !== this.money.currency) throw new CurrencyMismatchError();
    if (balance.isNegative()) throw new DomainError('INVALID_WALLET_BALANCE', 'Result balance cannot be negative');
  }
}
