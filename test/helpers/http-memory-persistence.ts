import { walletMapper, transactionMapper } from '../../src/database/domain-mappers';
import type { Wallet } from '../../src/modules/wallets/domain/wallet';
import type { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import type { WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import type { IntegrationEvent } from '../../src/shared/domain/integration-event';
import { WalletAlreadyExistsError } from '../../src/modules/wallets/application/wallet-opening-unit-of-work';
import type { HttpPersistence } from '../../src/http/http-api.module';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';

/** Controller test double using the real domain and use cases. It proves no PostgreSQL constraint or lock guarantee. */
export class HttpMemoryPersistence implements HttpPersistence {
  wallets = new Map<string, Wallet>();
  transactions = new Map<string, WagerTransaction>();
  ledger: WalletLedgerEntry[] = [];
  events: IntegrationEvent<unknown>[] = [];
  calls = 0;
  failure: unknown;
  closed = false;
  close = async () => { this.closed = true; };
  private async transaction<T>(callback: (state: ReturnType<HttpMemoryPersistence['copy']>) => Promise<T>): Promise<T> {
    this.calls++;
    if (this.failure) throw this.failure;
    const state = this.copy(); const result = await callback(state);
    this.wallets = state.wallets; this.transactions = state.transactions; this.ledger = state.ledger; this.events = state.events; return result;
  }
  private copy() {
    return {
      wallets: new Map([...this.wallets].map(([id, wallet]) => [id, walletMapper.toDomain(walletMapper.toRecord(wallet))])),
      transactions: new Map([...this.transactions].map(([id, tx]) => [id, transactionMapper.toDomain(transactionMapper.toRecord(tx))])),
      ledger: [...this.ledger], events: [...this.events],
    };
  }
  readonly walletOpening: HttpPersistence['walletOpening'] = { transaction: callback => this.transaction(async state => callback({
    insertWallet: async wallet => {
      if ([...state.wallets.values()].some(existing => existing.playerId === wallet.playerId && existing.currency === wallet.currency)) throw new WalletAlreadyExistsError();
      state.wallets.set(wallet.id, wallet);
    },
    insertOpening: async tx => { state.transactions.set(tx.id, tx); },
    insertLedgerEntry: async entry => { state.ledger.push(entry); },
    insertEvents: async events => { state.events.push(...events); },
  })) };
  readonly wagerProcessing: HttpPersistence['wagerProcessing'] = { transaction: callback => this.transaction(async state => callback({
    lockWallet: async id => state.wallets.get(id),
    loadTransaction: async id => state.transactions.get(id),
    findReference: async (provider, external) => [...state.transactions.values()].find(tx => tx.providerId === provider && tx.externalTransactionId === external),
    findProcessedReversals: async reference => [...state.transactions.values()].filter(tx => tx.referenceTransactionId === reference && tx.status === Status.Processed
      && (tx.kind === Kind.Refund || tx.kind === Kind.Rollback)),
    findIdentityCandidates: async key => [...state.transactions.values()].filter(tx => tx.idempotencyKey === key.idempotencyKey
      || (tx.providerId === key.providerId && tx.externalTransactionId === key.externalTransactionId)),
    insertPending: async tx => { state.transactions.set(tx.id, tx); },
    saveWallet: async wallet => { state.wallets.set(wallet.id, wallet); },
    completeTransaction: async tx => { state.transactions.set(tx.id, tx); },
    insertLedgerEntry: async entry => { state.ledger.push(entry); },
    insertEvents: async events => { state.events.push(...events); },
  })) };
}
