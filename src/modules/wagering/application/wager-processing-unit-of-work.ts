import type { WagerTransaction } from '../domain/wager-transaction';
import type { WagerIdentityKey } from './wager-transaction-identity';
import type { Wallet } from '../../wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../wallets/domain/wallet-ledger-entry';
import type { IntegrationEvent } from '../../../shared/domain/integration-event';

export interface WagerProcessingTransaction {
  findIdentityCandidates(identity: WagerIdentityKey): Promise<readonly WagerTransaction[]>;
  insertPending(transaction: WagerTransaction): Promise<void>;
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  loadTransaction(transactionId: string): Promise<WagerTransaction | undefined>;
  saveWallet(wallet: Wallet): Promise<void>;
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
