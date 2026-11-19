import { describe, expect, test } from 'bun:test';
import { JsonLogger } from '../../src/modules/operations/json-logger';
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
          case 'transaction-4': return 'expired';
          default: throw new Error('Simulated failure');
        }
      },
    };

    const lines: string[] = [];
      const result = await new RunPendingReferenceBatch(
        selector, processor, new JsonLogger(line => lines.push(line)),
      ).execute(6);

      expect(result).toEqual({
        selected: 6,
        processed: 1,
        rejected: 1,
        expired: 1,
        rescheduled: 1,
        skipped: 1,
        failed: 1,
      });

      expect(visited).toEqual(items.map(item => item.id));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', event: 'pending_reference.failed', transactionId: 'transaction-5', walletId: 'wallet' });
      expect(lines[0]!).not.toContain('Simulated failure');
  });

  test('counts legitimate expirations without operational failures', async () => {
    const selector: PendingReferenceSelector = {
      findDue: async () => [{ id: 'expired-transaction', walletId: 'wallet' }],
    };
    const processor: PendingReferenceProcessor = {
      execute: async () => 'expired',
    };

    expect(await new RunPendingReferenceBatch(selector, processor).execute()).toEqual({
      selected: 1,
      processed: 0,
      rejected: 0,
      expired: 1,
      rescheduled: 0,
      skipped: 0,
      failed: 0,
    });
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
