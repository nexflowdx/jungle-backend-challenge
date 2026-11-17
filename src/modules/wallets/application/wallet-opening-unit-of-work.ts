import type { IntegrationEvent } from '../../../shared/domain/integration-event';
import type { WagerTransaction } from '../../wagering/domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

export interface WalletOpeningTransaction {
  insertWallet(wallet: Wallet): Promise<void>;
  insertOpening(transaction: WagerTransaction): Promise<void>;
  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
  insertEvents(events: readonly IntegrationEvent<unknown>[]): Promise<void>;
}

export abstract class WalletOpeningUnitOfWork {
  /** Resolves only after commit; any callback or commit failure rolls back all writes. */
  abstract transaction<T>(work: (transaction: WalletOpeningTransaction) => Promise<T>): Promise<T>;
}

export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor() {
    super('A wallet already exists for this player and currency');
    this.name = 'WalletAlreadyExistsError';
  }
}
