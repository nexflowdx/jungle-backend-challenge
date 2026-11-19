import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PostgresOperationalMetrics } from '../../src/modules/operations/postgres-operational-metrics';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { ProcessWagerTransaction } from '../../src/modules/wagering/application/process-wager-transaction';
import { openTestWallet, testPersistence, wagerCommand, walletPersistenceSnapshot } from '../helpers/postgres-wager-fixtures';

describe.skipIf(process.env.PERSISTENCE_INTEGRATION !== '1')('database operational metrics with real PostgreSQL', () => {
  let orm: MikroORM;
  beforeAll(async () => { orm = await testPersistence(); await orm.getMigrator().up(); }, 30000);
  afterAll(async () => { await orm?.close(true); });
  test('status and retained transition counts include a committed operation once despite replay', async () => {
    const wallet = await openTestWallet(orm); const input = wagerCommand(wallet);
    const reader = new PostgresOperationalMetrics(orm); const before = await reader.read();
    const process = new ProcessWagerTransaction(new PostgresWagerProcessingUnitOfWork(orm));
    await process.execute(input); await process.execute(input);
    const after = await reader.read();
    const count = (rows: { status: string; count: string }[]) => BigInt(rows.find(row => row.status === 'PROCESSED')?.count ?? '0');
    expect(count(after.currentStates)).toBe(count(before.currentStates) + 1n);
    expect(count(after.recordedTransitions)).toBe(count(before.recordedTransitions) + 1n);
    expect(after.scope).toBe('database-retained-rows');
  });
  test('independent readers agree and aggregation does not modify financial records', async () => {
    const wallet = await openTestWallet(orm); const before = await walletPersistenceSnapshot(orm, wallet);
    const a = await new PostgresOperationalMetrics(orm).read(); const b = await new PostgresOperationalMetrics(orm).read();
    expect(a.currentStates).toEqual(b.currentStates); expect(a.recordedTransitions).toEqual(b.recordedTransitions);
    expect(await walletPersistenceSnapshot(orm, wallet)).toEqual(before);
    expect(BigInt(a.outbox.pending)).toBeGreaterThan(0n);
  });
});
