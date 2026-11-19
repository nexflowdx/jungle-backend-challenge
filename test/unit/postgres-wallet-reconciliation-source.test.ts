import { expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { IsolationLevel } from '@mikro-orm/core';
import { ReconcileWallet } from '../../src/modules/wallets/application/reconcile-wallet';
import { PostgresWalletReconciliationSource } from '../../src/modules/wallets/infrastructure/postgres-wallet-reconciliation-source';

// Adapter contract only: the real SQL arithmetic/snapshot is tested in integration.
function harness(overrides: Record<string, unknown> = {}, schema = 'public') {
  const statements: { sql: string; params: unknown[] }[] = []; let options: unknown;
  const row = { initial: '100', credits: '0.02', debits: '0.01', calculated: '100.01', difference: '0',
    entries: '3', invalid: '0', sequence_invalid: false, missing: '0', ...overrides };
  const manager = {
    getPlatform: () => ({ quoteIdentifier: (name: string) => name.split('.').map(part => `"${part}"`).join('.') }),
    execute: async (sql: string, params: unknown[]) => {
      statements.push({ sql, params });
      expect(sql.match(/\?/g)?.length ?? 0).toBe(params.length);
      return statements.length === 1 ? [{ id: 'wallet', balance: '100.01', currency: 'BRL', version: 3 }] : [row];
    },
  };
  const orm = { config: { get: () => schema }, em: { fork: () => ({
    transactional: async (work: (em: typeof manager) => Promise<unknown>, settings: unknown) => { options = settings; return work(manager); },
  }) } } as unknown as MikroORM;
  return { source: new PostgresWalletReconciliationSource(orm), statements, options: () => options };
}
test('adapter uses one repeatable read read-only scope and parameterized wallet/summary reads', async () => {
  const fixture = harness();
  const result = await new ReconcileWallet(fixture.source).execute('wallet');
  expect(fixture.options()).toEqual({ isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true });
  expect(fixture.statements).toHaveLength(2);
  expect(fixture.statements[0]!.params).toEqual(['wallet']);
  expect(result).toMatchObject({ initialBalance: { amount: '100.00' }, difference: { amount: '0.00' }, status: 'CONSISTENT' });
});
test('signed and unbounded aggregate decimals are formatted without individual Money coercion', async () => {
  const fixture = harness({ credits: '184467440737095516.14', difference: '-0.01' });
  const result = await new ReconcileWallet(fixture.source).execute('wallet');
  expect(result.credits?.amount).toBe('184467440737095516.14'); expect(result.difference?.amount).toBe('-0.01'); expect(result.status).toBe('DIVERGENT');
});
test('missing opening, invalid entries, chain and missing financial movements are explicit issues', async () => {
  const fixture = harness({ initial: null, invalid: '1', sequence_invalid: true, missing: '1' });
  const result = await new ReconcileWallet(fixture.source).execute('wallet');
  expect(result.issues).toEqual(['INITIAL_BALANCE_UNPROVEN', 'INVALID_LEDGER_ENTRIES', 'INVALID_LEDGER_SEQUENCE', 'MISSING_FINANCIAL_ENTRIES']);
  expect(result.calculatedBalance).toBeNull(); expect(result.difference).toBeNull(); expect(result.status).toBe('INCONCLUSIVE');
});
test('trusted ORM schema selects isolated fixture tables without changing search_path', async () => {
  const fixture = harness({}, 'isolated_fixture'); await new ReconcileWallet(fixture.source).execute('wallet');
  expect(fixture.statements[0]!.sql).toContain('"isolated_fixture"."wallets"');
  expect(fixture.statements[1]!.sql).toContain('"isolated_fixture"."wallet_ledger_entries"');
});
test.each(['NaN', 'Infinity', '1.001', 1.01])('unexpected aggregate format %# fails rather than rounding', async credits => {
  await expect(new ReconcileWallet(harness({ credits }).source).execute('wallet')).rejects.toThrow('Invalid reconciliation decimal');
});
test('unsafe row counts are rejected instead of silently losing count precision', async () => {
  await expect(new ReconcileWallet(harness({ entries: '9007199254740993' }).source).execute('wallet')).rejects.toThrow('count exceeds safe integer');
});
