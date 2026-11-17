import type { WalletOpeningTransaction, WalletOpeningUnitOfWork } from '../../src/modules/wallets/application/wallet-opening-unit-of-work';

export type OpeningFailurePoint = 'after-wallet' | 'after-opening' | 'after-ledger' | 'after-outbox' | 'before-commit';

/** Decorates the real transactional port: each preceding write has actually flushed. */
export function withOpeningFailure(work: WalletOpeningUnitOfWork, point: OpeningFailurePoint): WalletOpeningUnitOfWork {
  const fail = (current: OpeningFailurePoint): void => {
    if (current === point) throw new Error(`Injected opening failure: ${point}`);
  };
  return {
    transaction: callback => work.transaction(async transaction => {
      const failing: WalletOpeningTransaction = {
        insertWallet: async wallet => { await transaction.insertWallet(wallet); fail('after-wallet'); },
        insertOpening: async opening => { await transaction.insertOpening(opening); fail('after-opening'); },
        insertLedgerEntry: async entry => { await transaction.insertLedgerEntry(entry); fail('after-ledger'); },
        insertEvents: async events => { await transaction.insertEvents(events); fail('after-outbox'); },
      };
      const result = await callback(failing);
      fail('before-commit');
      return result;
    }),
  };
}
