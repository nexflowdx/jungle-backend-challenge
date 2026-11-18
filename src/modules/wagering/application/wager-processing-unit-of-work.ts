import type { WagerTransaction } from '../domain/wager-transaction';
import type { WagerIdentityKey } from './wager-transaction-identity';
import type { Wallet } from '../../wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry';
import type { WagerInboxTransaction } from './wager-inbox';
import type { IntegrationEvent } from '../../../shared/domain/integration-event';

export interface WagerProcessingTransaction {
  /** Optional for HTTP-only adapters; message processing fails closed when this is absent. */
  readonly inbox?: WagerInboxTransaction;
  findIdentityCandidates(identity: WagerIdentityKey): Promise<readonly WagerTransaction[]>;
  insertPending(transaction: WagerTransaction): Promise<void>;
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  loadTransaction(transactionId: string): Promise<WagerTransaction | undefined>;
  /** Read under the wallet lock; never acquires another wallet/transaction lock. */
  findReference(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Processed reversals of this reference, read under the same wallet lock. */
  findProcessedReversals(referenceTransactionId: string): Promise<readonly WagerTransaction[]>;
  saveWallet(wallet: Wallet): Promise<void>;
  /** Persist the initial decision: terminal result or durable PENDING_REFERENCE acceptance. */
  completeTransaction(transaction: WagerTransaction): Promise<void>;
  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  insertEvents(events: readonly IntegrationEvent<unknown>[]): Promise<void>;
}

export class WagerProcessingRetryableError extends Error {
  constructor(readonly sqlState: '40P01' | '40001', cause: unknown) {
    super('Retryable wager transaction failure', { cause });
    this.name = 'WagerProcessingRetryableError';
  }
}

export abstract class WagerProcessingUnitOfWork {
  /** Resolves after commit; callback and commit failures roll back and propagate. */
  abstract transaction<T>(work: (scope: WagerProcessingTransaction) => Promise<T>): Promise<T>;
}
