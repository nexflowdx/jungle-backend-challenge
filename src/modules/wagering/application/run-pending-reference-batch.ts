import type {
  PendingReferenceWorkItem,
  PendingReferenceOutcome,
} from './process-pending-reference';
import { JsonLogger, jsonLogger } from '../../operations/json-logger';
import { runWithLogContext } from '../../operations/log-context';

export interface PendingReferenceSelector {
  findDue(limit: number): Promise<readonly PendingReferenceWorkItem[]>;
}

export interface PendingReferenceProcessor {
  execute(item: PendingReferenceWorkItem): Promise<PendingReferenceOutcome>;
}

export interface PendingReferenceBatchResult {
  readonly selected: number;
  readonly processed: number;
  readonly rejected: number;
  readonly expired: number;
  readonly rescheduled: number;
  readonly skipped: number;
  readonly failed: number;
}

export class RunPendingReferenceBatch {
  constructor(
    private readonly selector: PendingReferenceSelector,
    private readonly processor: PendingReferenceProcessor,
    private readonly logger: JsonLogger = jsonLogger,
  ) {}

  async execute(limit = 50): Promise<PendingReferenceBatchResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Invalid pending reference batch size');
    }

    const items = await this.selector.findDue(limit);

    const result = {
      selected: items.length,
      processed: 0,
      rejected: 0,
      expired: 0,
      rescheduled: 0,
      skipped: 0,
      failed: 0,
    };

    for (const item of items) {
      try {
        const outcome = await this.processor.execute(item);
        result[outcome]++;
      } catch {
        result.failed++;
        runWithLogContext({ transactionId: item.id, walletId: item.walletId }, () => this.logger.emit('error', 'pending_reference.failed'));
      }
    }

    return result;
  }
}
