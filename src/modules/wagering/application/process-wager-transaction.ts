import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertIdentifier } from '../../../shared/domain/financial-rules';
import type { MoneyProps } from '../../../shared/domain/money';
import type { WagerTransaction } from '../domain/wager-transaction';
import { createTransactionEvents } from '../domain/wagering.events';
import { type FailureCode, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../domain/wager-transaction.types';
import { WagerRequestFingerprint, type WagerIdentityRequest } from './wager-request-fingerprint';
import { WagerIdentityCollisionError, WagerTransactionIdentity } from './wager-transaction-identity';
import { WagerProcessingRetryableError, WagerProcessingUnitOfWork } from './wager-processing-unit-of-work';

export interface SupportedWagerCommand extends WagerIdentityRequest {
  readonly kind: Kind.Bet | Kind.Win | Kind.Loss | Kind.Refund | Kind.Rollback;
  readonly correlationId: string;
  readonly causationId?: string;
}
export interface BetCommand extends SupportedWagerCommand { readonly kind: Kind.Bet; }
export type ProcessWagerTransactionCommand = SupportedWagerCommand | { readonly walletId: string; readonly kind: Exclude<Kind, Kind.Bet | Kind.Win | Kind.Loss | Kind.Refund | Kind.Rollback> };

export interface ProcessWagerTransactionResult {
  readonly transactionId: string;
  readonly status: Status.Processed | Status.Rejected | Status.PendingReference;
  readonly balance: Readonly<MoneyProps>;
  readonly failureCode?: FailureCode;
  readonly idempotentReplay: boolean;
}
export interface ProcessingRuntime {
  newId(): string;
  now(): Date;
  retryDelay(attempt: number): Promise<void>;
}
export class WagerProcessingNotImplementedError extends Error {
  readonly code = 'WAGER_PROCESSING_NOT_IMPLEMENTED';
  constructor(readonly kind: Kind) { super('Wager processing is not implemented for this operation'); this.name = 'WagerProcessingNotImplementedError'; }
}
export class WagerResultUnavailableError extends Error {
  readonly code = 'WAGER_RESULT_NOT_AVAILABLE';
  constructor() { super('No persisted wager result or acceptance is available'); this.name = 'WagerResultUnavailableError'; }
}
export class WagerWalletNotFoundError extends Error {
  readonly code = 'WALLET_NOT_FOUND';
  constructor() { super('Wallet does not exist'); this.name = 'WagerWalletNotFoundError'; }
}

export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: WagerProcessingUnitOfWork,
    private readonly identity = new WagerTransactionIdentity(),
    private readonly runtime: ProcessingRuntime = {
      newId: randomUUID, now: () => new Date(),
      retryDelay: async attempt => { await sleep(10 * 2 ** attempt + Math.floor(Math.random() * 10)); },
    },
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    if ((command.kind !== Kind.Bet && command.kind !== Kind.Win && command.kind !== Kind.Loss
      && command.kind !== Kind.Refund && command.kind !== Kind.Rollback)
      || ((command.kind === Kind.Bet || command.kind === Kind.Loss) && command.referenceExternalTransactionId !== undefined)) {
      throw new WagerProcessingNotImplementedError(command.kind);
    }
    assertIdentifier(command.correlationId);
    if (command.causationId !== undefined) assertIdentifier(command.causationId);
    const fingerprint = WagerRequestFingerprint.from(command);
    const request = Object.freeze({ ...fingerprint.business, idempotencyKey: fingerprint.idempotencyKey });
    const context = { correlationId: command.correlationId,
      ...(command.causationId === undefined ? {} : { causationId: command.causationId }) };
    for (let attempt = 0; ; attempt++) {
      try { return await this.processAttempt(request, context); }
      catch (error) {
        if (!(error instanceof WagerProcessingRetryableError) || attempt >= 2) throw error;
        await this.runtime.retryDelay(attempt);
      }
    }
  }

  private async processAttempt(request: WagerIdentityRequest, context: { correlationId: string; causationId?: string }): Promise<ProcessWagerTransactionResult> {
    const candidate = this.identity.createCandidate(request, this.runtime.newId(), this.runtime.now());
    try {
      return await this.unitOfWork.transaction(async scope => {
        const wallet = await scope.lockWallet(candidate.walletId);
        if (!wallet) throw new WagerWalletNotFoundError();
        const outcome = await this.identity.resolve(candidate, scope);
        if (outcome.kind === 'identity-replay') return this.result(await scope.loadTransaction(outcome.transactionId), true);
        const reference = candidate.referenceExternalTransactionId === undefined ? undefined
          : await scope.findReference(candidate.providerId, candidate.referenceExternalTransactionId);
        const priorReversals = candidate.requiresReference() && reference
          ? await scope.findProcessedReversals(reference.id) : [];
        const at = this.runtime.now();
        const entry = candidate.process(wallet, { at, ledgerEntryId: this.runtime.newId(), priorReversals,
          ...(reference === undefined ? {} : { reference }) });
        if (entry) await scope.saveWallet(wallet);
        await scope.completeTransaction(candidate);
        if (entry) await scope.insertLedgerEntry(entry);
        const events = createTransactionEvents(candidate, wallet, entry, () => ({
          ...context, eventId: this.runtime.newId(), occurredAt: candidate.completedAt ?? at,
        }));
        await scope.insertEvents(events);
        return this.result(candidate, false);
      });
    } catch (error) {
      if (!(error instanceof WagerIdentityCollisionError)) throw error;
      const outcome = await this.identity.recoverAfterRollback(candidate, error, this.unitOfWork);
      return this.unitOfWork.transaction(async scope => {
        if (!await scope.lockWallet(candidate.walletId)) throw new WagerWalletNotFoundError();
        return this.result(await scope.loadTransaction(outcome.transactionId), true);
      });
    }
  }

  private result(transaction: WagerTransaction | undefined, replay: boolean): ProcessWagerTransactionResult {
    if (!transaction || (transaction.kind !== Kind.Bet && transaction.kind !== Kind.Win && transaction.kind !== Kind.Loss
      && transaction.kind !== Kind.Refund && transaction.kind !== Kind.Rollback)
      || !transaction.balance) throw new WagerResultUnavailableError();
    if (transaction.status === Status.PendingReference) {
      if ((transaction.kind !== Kind.Win && !transaction.requiresReference()) || !transaction.referenceExternalTransactionId || !transaction.acceptedBalance
        || transaction.completedAt || transaction.failureCode) throw new WagerResultUnavailableError();
    } else if (!transaction.completedAt || (transaction.status !== Status.Processed && transaction.status !== Status.Rejected)
      || (transaction.status === Status.Rejected && !transaction.failureCode)) throw new WagerResultUnavailableError();
    return Object.freeze({ transactionId: transaction.id, status: transaction.status,
      balance: Object.freeze(transaction.balance.toJSON()), idempotentReplay: replay,
      ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }) });
  }
}
