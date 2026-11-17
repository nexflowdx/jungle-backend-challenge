import type { WagerTransaction } from '../domain/wager-transaction';
import type { WagerIdentityKey } from './wager-transaction-identity';

export interface WagerProcessingTransaction {
  findIdentityCandidates(identity: WagerIdentityKey): Promise<readonly WagerTransaction[]>;
  insertPending(transaction: WagerTransaction): Promise<void>;
}

export abstract class WagerProcessingUnitOfWork {
  /** Resolves after commit; callback and commit failures roll back and propagate. */
  abstract transaction<T>(work: (scope: WagerProcessingTransaction) => Promise<T>): Promise<T>;
}
