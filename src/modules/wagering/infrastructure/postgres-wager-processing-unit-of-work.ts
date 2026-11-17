import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { transactionMapper } from '../../../database/domain-mappers';
import { WagerTransactionRecord } from '../../../database/entities';
import { runPostgresTransaction } from '../../../database/postgres-transaction';
import { WagerProcessingUnitOfWork, type WagerProcessingTransaction } from '../application/wager-processing-unit-of-work';
import { WagerIdentityCollisionError } from '../application/wager-transaction-identity';
import { WagerTransactionStatus } from '../domain/wager-transaction.types';

export class PostgresWagerProcessingUnitOfWork extends WagerProcessingUnitOfWork {
  constructor(private readonly orm: MikroORM) { super(); }

  override async transaction<T>(work: (scope: WagerProcessingTransaction) => Promise<T>): Promise<T> {
    try {
      return await runPostgresTransaction(this.orm, async manager => {
        let active = true;
        let failure: { error: unknown } | undefined;
        const operation = async <R>(run: () => Promise<R>): Promise<R> => {
          if (!active || failure) throw new Error('Wager persistence scope is closed or failed');
          try { return await run(); }
          catch (error) { failure = { error }; throw error; }
        };
        try {
          const result = await work({
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
      // runPostgresTransaction has completed rollback before identity recovery is possible.
      if (error instanceof UniqueConstraintViolationException && error.code === '23505' && 'constraint' in error) {
        if (error.constraint === 'wager_transactions_idempotency_key_key') throw new WagerIdentityCollisionError('idempotency-key');
        if (error.constraint === 'transactions_provider_external_unique') throw new WagerIdentityCollisionError('provider-external');
      }
      throw error;
    }
  }
}
