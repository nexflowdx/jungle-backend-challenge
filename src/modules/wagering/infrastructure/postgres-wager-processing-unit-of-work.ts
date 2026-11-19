import { DeadlockException, LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ledgerMapper, outboxRecord, transactionMapper, walletMapper } from '../../../database/domain-mappers';
import { InboxMessageRecord, WagerTransactionRecord, WalletRecord } from '../../../database/entities';
import { runPostgresTransaction } from '../../../database/postgres-transaction';
import { operationalMetrics } from '../../operations/operational-metrics';
import { WagerProcessingRetryableError, WagerProcessingUnitOfWork, type WagerProcessingTransaction } from '../application/wager-processing-unit-of-work';
import { WagerIdentityCollisionError } from '../application/wager-transaction-identity';
import { WagerInboxConflictError, type WagerInboxIdentity } from '../application/wager-inbox';
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
        let claimedMessage: WagerInboxIdentity | undefined;
        let inboxCompleted = false;
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
            inbox: {
              claim: (message, receivedAt) => operation(async () => {
                if (lockedWalletId || claimedMessage) throw new Error('Claim exactly one inbox message before locking a wallet');
                // ON CONFLICT waits for an uncommitted winner without aborting this transaction.
                await manager.getConnection().execute(`INSERT INTO inbox_messages
                  (message_id,consumer_name,payload_hash,received_at) VALUES (?,?,?,?)
                  ON CONFLICT (message_id,consumer_name) DO NOTHING`,
                  [message.messageId, message.consumerName, message.payloadHash, receivedAt], 'all', manager.getTransactionContext());
                const record = await manager.findOneOrFail(InboxMessageRecord, {
                  messageId: message.messageId, consumerName: message.consumerName,
                }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
                if (record.payloadHash !== message.payloadHash) throw new WagerInboxConflictError();
                claimedMessage = Object.freeze({ ...message }); inboxCompleted = record.processedAt !== null;
                return inboxCompleted ? 'completed' : 'unprocessed';
              }),
              complete: processedAt => operation(async () => {
                if (!claimedMessage || !lockedWalletId || inboxCompleted) throw new Error('Inbox completion requires an unfinished claim and locked wallet');
                const changed = await manager.nativeUpdate(InboxMessageRecord, {
                  messageId: claimedMessage.messageId, consumerName: claimedMessage.consumerName, processedAt: null,
                }, { processedAt });
                if (changed !== 1) throw new Error('Inbox completion failed');
                inboxCompleted = true;
              }),
            },
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
            loadPendingReferenceContext: transactionId => operation(async () => {
              if (!lockedWalletId) throw new Error('Context lookup requires the locked wallet');

              const rows = await manager.getConnection().execute<
                { payload: { correlationId?: unknown; causationId?: unknown } }[]
              >(
                `SELECT payload FROM outbox_messages
                 WHERE aggregate_id = ?
                   AND event_type = 'WagerTransactionPendingReference'
                   AND payload->'data'->>'transactionId' = ?
                 ORDER BY occurred_at, id
                 LIMIT 2`,
                [lockedWalletId, transactionId], 'all', manager.getTransactionContext(),
              );

              if (rows.length !== 1) {
                throw new Error('Original pending reference context is missing or ambiguous');
              }

              const { correlationId, causationId } = rows[0]!.payload;

              if (typeof correlationId !== 'string'
                || (causationId !== undefined && typeof causationId !== 'string')) {
                throw new Error('Invalid original pending reference context');
              }

              return {
                correlationId,
                ...(causationId === undefined ? {} : { causationId }),
              };
            }),
            completePendingReference: transaction => operation(async () => {
              requireWallet(transaction.walletId);
              if (transaction.status !== WagerTransactionStatus.Processed
                && transaction.status !== WagerTransactionStatus.Rejected
                && transaction.status !== WagerTransactionStatus.Failed) {
                throw new Error('Pending reference must reach a terminal decision');
              }
              const record = await manager.findOneOrFail(WagerTransactionRecord, {
                id: transaction.id, walletId: lockedWalletId!,
              }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
              if (record.status !== WagerTransactionStatus.PendingReference) {
                throw new Error('Only PENDING_REFERENCE can be resumed');
              }
              const updated = transactionMapper.toRecord(transaction);
              updated.referenceAttempts = record.referenceAttempts;
              updated.nextReferenceAttemptAt = record.nextReferenceAttemptAt;
              updated.referenceDeadlineAt = record.referenceDeadlineAt;
              manager.assign(record, updated);
              await manager.flush();
            }),
            loadPendingReferenceSchedule: transactionId => operation(async () => {
              if (!lockedWalletId) throw new Error('Schedule lookup requires the locked wallet');
              const record = await manager.findOne(WagerTransactionRecord, {
                id: transactionId,
                walletId: lockedWalletId,
                status: WagerTransactionStatus.PendingReference,
              }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
              if (!record) return undefined;
              return {
                attempts: record.referenceAttempts,
                nextAttemptAt: record.nextReferenceAttemptAt,
                deadlineAt: record.referenceDeadlineAt,
              };
            }),
            schedulePendingReference: (transactionId, attempts, nextAttemptAt, deadlineAt, attemptedAt) => operation(async () => {
              if (!lockedWalletId) throw new Error('Scheduling requires a locked wallet');
              if (!Number.isSafeInteger(attempts) || attempts < 1
                || !Number.isFinite(nextAttemptAt.getTime())
                || !Number.isFinite(deadlineAt.getTime())) {
                throw new Error('Invalid reference retry schedule');
              }
              const changed = await manager.nativeUpdate(WagerTransactionRecord, {
                id: transactionId, walletId: lockedWalletId,
                status: WagerTransactionStatus.PendingReference,
                referenceAttempts: attempts - 1,
                $or: [
                  { nextReferenceAttemptAt: null },
                  { nextReferenceAttemptAt: { $lte: attemptedAt } },
                ],
              }, {
                referenceAttempts: attempts,
                nextReferenceAttemptAt: nextAttemptAt,
                referenceDeadlineAt: deadlineAt,
              });
              if (changed !== 1) throw new Error('Pending reference scheduling failed');
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
          if (claimedMessage && !inboxCompleted) throw new Error('Cannot commit an unfinished inbox message');
          return result;
        } finally { active = false; }
      });
    } catch (error) {
      operationalMetrics.observeSqlFailure(error);
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
