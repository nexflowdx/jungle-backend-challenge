import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ledgerMapper, outboxRecord, transactionMapper, walletMapper } from '../../../database/domain-mappers';
import { WalletAlreadyExistsError, WalletOpeningUnitOfWork, type WalletOpeningTransaction } from '../application/wallet-opening-unit-of-work';

export class PostgresWalletOpeningUnitOfWork extends WalletOpeningUnitOfWork {
  constructor(private readonly orm: MikroORM) { super(); }

  override async transaction<T>(work: (transaction: WalletOpeningTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async em => work({
        insertWallet: async wallet => { await em.persistAndFlush(walletMapper.toRecord(wallet)); },
        insertOpening: async opening => { await em.persistAndFlush(transactionMapper.toRecord(opening)); },
        insertLedgerEntry: async entry => { await em.persistAndFlush(ledgerMapper.toRecord(entry)); },
        insertEvents: async events => { await em.persistAndFlush(events.map(outboxRecord)); },
      }));
    } catch (error) {
      // Translate only the player/currency conflict, after transactional has rolled back.
      if (error instanceof UniqueConstraintViolationException && 'constraint' in error
        && error.constraint === 'wallets_player_currency_unique') {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
  }
}
