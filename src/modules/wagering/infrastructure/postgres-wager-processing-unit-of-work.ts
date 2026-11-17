import { DeadlockException, LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ledgerMapper, outboxRecord, transactionMapper, walletMapper } from '../../../database/domain-mappers';
import { WagerTransactionRecord, WalletRecord } from '../../../database/entities';
import { runPostgresTransaction } from '../../../database/postgres-transaction';
import { WagerProcessingRetryableError, WagerProcessingUnitOfWork, type WagerProcessingTransaction } from '../application/wager-processing-unit-of-work';
import { WagerIdentityCollisionError } from '../application/wager-transaction-identity';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction.types';

export class PostgresWagerProcessingUnitOfWork extends WagerProcessingUnitOfWork {
  constructor(private readonly orm: MikroORM) { super(); }

  override async transaction<T>(work: (scope: WagerProcessingTransaction) => Promise<T>): Promise<T> {
    try {
      return await runPostgresTransaction(this.orm, async manager => {
        let active = true;
        let failure: { error: unknown } | undefined;
        let lockedWalletId: string | undefined;
        let lockedVersion: number | undefined;
        const requireWallet = (walletId: string): void => {
          if (lockedWalletId !== walletId) throw new Error('Financial writes require the locked wallet');
        };
        const operation = async <R>(run: () => Promise<R>): Promise<R> => {
          if (!active || failure) throw new Error('Wager persistence scope is closed or failed');
          try { return await run(); }
          catch (error) { failure = { error }; throw error; }
        };
        try {
          const result = await work({
            lockWallet: walletId => operation(async () => {
              if (lockedWalletId && lockedWalletId !== walletId) throw new Error('A transaction can lock only one wallet');
              const record = await manager.findOne(WalletRecord, walletId, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
              if (!record) return undefined;
              lockedWalletId = record.id;
              lockedVersion = record.version;
              return walletMapper.toDomain(record);
            }),
            loadTransaction: transactionId => operation(async () => {
              if (!lockedWalletId) throw new Error('Load the transaction after locking its wallet');
              const record = await manager.findOne(WagerTransactionRecord, { id: transactionId, walletId: lockedWalletId },
                { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
              return record ? transactionMapper.toDomain(record) : undefined;
            }),
            findReference: (providerId, externalTransactionId) => operation(async () => {
              if (!lockedWalletId) throw new Error('Load references after locking the wallet');
              // Do not filter by wallet: the domain must reject a cross-wallet reference.
              // No reference row lock: terminal records are immutable; no second wallet is locked.
              const record = await manager.findOne(WagerTransactionRecord, { providerId, externalTransactionId }, { refresh: true });
              return record ? transactionMapper.toDomain(record) : undefined;
            }),
            findProcessedReversals: referenceTransactionId => operation(async () => {
              if (!lockedWalletId) throw new Error('Load reversals after locking the wallet');
              const records = await manager.find(WagerTransactionRecord, {
                walletId: lockedWalletId, referenceTransactionId, status: WagerTransactionStatus.Processed,
                kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
              }, { refresh: true });
              return records.map(record => transactionMapper.toDomain(record));
            }),
            saveWallet: wallet => operation(async () => {
              requireWallet(wallet.id);
              const changed = await manager.nativeUpdate(WalletRecord, { id: wallet.id, version: lockedVersion! }, {
                balance: wallet.balance.toString(), version: wallet.version, updatedAt: wallet.updatedAt,
              });
              if (changed !== 1) throw new Error('Locked wallet version changed unexpectedly');
              lockedVersion = wallet.version;
            }),
            completeTransaction: transaction => operation(async () => {
              requireWallet(transaction.walletId);
              if (transaction.status !== WagerTransactionStatus.Processed && transaction.status !== WagerTransactionStatus.Rejected
                && transaction.status !== WagerTransactionStatus.PendingReference) {
                throw new Error('Decision requires a processed, rejected or pending-reference result');
              }
              const record = await manager.findOneOrFail(WagerTransactionRecord, { id: transaction.id, walletId: lockedWalletId! });
              if (record.status !== WagerTransactionStatus.Pending) throw new Error('Only a pending transaction can complete');
              manager.assign(record, transactionMapper.toRecord(transaction));
              await manager.flush();
            }),
            insertLedgerEntry: entry => operation(async () => {
              requireWallet(entry.walletId);
              await manager.persistAndFlush(ledgerMapper.toRecord(entry));
            }),
            insertEvents: events => operation(async () => {
              for (const event of events) requireWallet(event.aggregateId);
              await manager.persistAndFlush(events.map(outboxRecord));
            }),
            findIdentityCandidates: identity => operation(async () => {
              const records = await manager.find(WagerTransactionRecord, { $or: [
                { idempotencyKey: identity.idempotencyKey },
                { providerId: identity.providerId, externalTransactionId: identity.externalTransactionId },
              ] }, { refresh: true });
              return records.map(record => transactionMapper.toDomain(record));
            }),
            insertPending: transaction => operation(async () => {
              if (transaction.status !== WagerTransactionStatus.Pending) throw new Error('Identity insertion requires PENDING');
              await manager.persistAndFlush(transactionMapper.toRecord(transaction));
            }),
          });
          // A callback cannot turn a swallowed database failure into a successful commit.
          if (failure) throw failure.error;
          return result;
        } finally { active = false; }
      });
    } catch (error) {
      if (error instanceof DeadlockException && (error.code === '40P01' || error.code === '40001')) {
        throw new WagerProcessingRetryableError(error.code, error);
      }
      // runPostgresTransaction has completed rollback before identity recovery is possible.
      if (error instanceof UniqueConstraintViolationException && error.code === '23505' && 'constraint' in error) {
        if (error.constraint === 'wager_transactions_idempotency_key_key') throw new WagerIdentityCollisionError('idempotency-key');
        if (error.constraint === 'transactions_provider_external_unique') throw new WagerIdentityCollisionError('provider-external');
      }
      throw error;
    }
  }
}
