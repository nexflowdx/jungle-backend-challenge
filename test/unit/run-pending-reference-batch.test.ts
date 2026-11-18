import { describe, expect, test } from 'bun:test';
import {
  RunPendingReferenceBatch,
  type PendingReferenceSelector,
  type PendingReferenceProcessor,
} from '../../src/modules/wagering/application/run-pending-reference-batch';

describe('RunPendingReferenceBatch', () => {
  test('counts outcomes and isolates individual failures', async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      id: `transaction-${index}`,
      walletId: 'wallet',
    }));

    const selector: PendingReferenceSelector = {
      findDue: async limit => {
        expect(limit).toBe(6);
        return items;
      },
    };

    const visited: string[] = [];

    const processor: PendingReferenceProcessor = {
      execute: async item => {
        visited.push(item.id);

        switch (item.id) {
          case 'transaction-0': return 'processed';
          case 'transaction-1': return 'rejected';
          case 'transaction-2': return 'rescheduled';
          case 'transaction-3': return 'skipped';
          case 'transaction-4': return 'failed';
          default: throw new Error('Simulated failure');
        }
      },
    };

    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => { errors.push(args); };

    try {
      const result = await new RunPendingReferenceBatch(
        selector, processor,
      ).execute(6);

      expect(result).toEqual({
        selected: 6,
        processed: 1,
        rejected: 1,
        rescheduled: 1,
        skipped: 1,
        failed: 2,
      });

      expect(visited).toEqual(items.map(item => item.id));
      expect(errors).toHaveLength(1);
    } finally {
      console.error = originalError;
    }
  });

  test('rejects invalid batch sizes before querying', async () => {
    const selector: PendingReferenceSelector = {
      findDue: async () => {
        throw new Error('Selector must not run');
      },
    };

    const processor: PendingReferenceProcessor = {
      execute: async () => 'skipped',
    };

    const runner = new RunPendingReferenceBatch(selector, processor);

    await expect(runner.execute(0)).rejects.toThrow(
      'Invalid pending reference batch size',
    );

    await expect(runner.execute(501)).rejects.toThrow(
      'Invalid pending reference batch size',
    );
  });
});
