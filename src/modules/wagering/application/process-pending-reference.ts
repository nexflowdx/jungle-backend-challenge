import { randomUUID } from 'node:crypto';
import type { WagerProcessingUnitOfWork } from './wager-processing-unit-of-work';
import { FailureCode, WagerTransactionStatus as Status } from '../domain/wager-transaction.types';
import { createTransactionEvents } from '../domain/wagering.events';
import { JsonLogger, jsonLogger } from '../../operations/json-logger';
import { runWithLogContext, type LogIdentifiers } from '../../operations/log-context';
import { operationalMetrics } from '../../operations/operational-metrics';

export interface PendingReferenceWorkItem {
  readonly id: string;
  readonly walletId: string;
}

export type PendingReferenceOutcome =
  | 'processed'
  | 'rejected'
  | 'expired'
  | 'rescheduled'
  | 'skipped';

export class ProcessPendingReference {
  constructor(
    private readonly unitOfWork: WagerProcessingUnitOfWork,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
    private readonly logger: JsonLogger = jsonLogger,
  ) {}

  async execute(item: PendingReferenceWorkItem): Promise<PendingReferenceOutcome> {
    let logContext: LogIdentifiers = { transactionId: item.id, walletId: item.walletId };
    const outcome = await this.unitOfWork.transaction(async scope => {
      if (!scope.loadPendingReferenceSchedule
        || !scope.loadPendingReferenceContext
        || !scope.completePendingReference
        || !scope.schedulePendingReference) {
        throw new Error('Pending reference persistence is unavailable');
      }

      const wallet = await scope.lockWallet(item.walletId);
      if (!wallet) throw new Error('Pending reference wallet not found');

      const transaction = await scope.loadTransaction(item.id);
      if (!transaction || transaction.status !== Status.PendingReference) {
        return 'skipped';
      }
      logContext = { ...logContext, providerId: transaction.providerId };

      const schedule = await scope.loadPendingReferenceSchedule(item.id);
      if (!schedule) return 'skipped';

      const at = this.now();
      const deadlineAt = new Date(transaction.createdAt.getTime() + 24 * 60 * 60 * 1000);
      const expired = at >= deadlineAt;
      if (!expired && schedule.nextAttemptAt && schedule.nextAttemptAt > at) {
        return 'skipped';
      }

      const reference = transaction.referenceExternalTransactionId === undefined
        ? undefined
        : await scope.findReference(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
        );

      const priorReversals = transaction.requiresReference() && reference
        ? await scope.findProcessedReversals(reference.id)
        : [];

      const entry = transaction.process(wallet, {
        at,
        ledgerEntryId: this.newId(),
        priorReversals,
        ...(reference === undefined ? {} : { reference }),
      });

      if (transaction.status === Status.PendingReference && expired) {
        transaction.fail(FailureCode.ReferenceNotFound, wallet.balance, at);
      }

      if (transaction.status === Status.PendingReference) {
        const attempts = schedule.attempts + 1;
        const delayMs = Math.min(60_000 * 2 ** Math.min(attempts - 1, 6), 3_600_000);
        await scope.schedulePendingReference(
          transaction.id,
          attempts,
          new Date(at.getTime() + delayMs),
          deadlineAt,
          at,
        );
        return 'rescheduled';
      }

      if (entry) await scope.saveWallet(wallet);
      await scope.completePendingReference(transaction);
      if (entry) await scope.insertLedgerEntry(entry);

      const context = await scope.loadPendingReferenceContext(transaction.id);
      logContext = { ...logContext, correlationId: context.correlationId, providerId: transaction.providerId };
      const events = createTransactionEvents(transaction, wallet, entry, () => ({
        ...context,
        eventId: this.newId(),
        occurredAt: transaction.completedAt ?? at,
      }));

      await scope.insertEvents(events);

      return transaction.status === Status.Processed ? 'processed'
        : transaction.status === Status.Failed ? 'expired' : 'rejected';
    });
    if (outcome === 'rescheduled') operationalMetrics.increment('reference_retries_scheduled');
    runWithLogContext(logContext, () => this.logger.emit('info', 'pending_reference.completed'));
    return outcome;
  }
}
