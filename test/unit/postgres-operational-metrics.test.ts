import { expect, test } from 'bun:test';
import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PostgresOperationalMetrics } from '../../src/modules/operations/postgres-operational-metrics';

test('database metrics use a single read-only repeatable-read scope, qualified tables and exact text counts', async () => {
  const statements: string[] = []; let options: unknown;
  const responses = [[{ status: 'PROCESSED', count: '9007199254740993' }], [{ status: 'PROCESSED', count: '2' }],
    [{ pending: '1', oldest_age_seconds: '12.345' }], [{ completed: '2', average_seconds: '0.5', maximum_seconds: '1' }]];
  const em = { getPlatform: () => ({ quoteIdentifier: (name: string) => name.split('.').map(part => `"${part}"`).join('.') }),
    execute: async (sql: string) => { statements.push(sql); return responses[statements.length - 1]; } };
  const orm = { config: { get: () => 'fixture' }, em: { fork: () => ({ transactional: async (work: (manager: typeof em) => unknown, settings: unknown) => {
    options = settings; return work(em);
  } }) } } as unknown as MikroORM;
  const result = await new PostgresOperationalMetrics(orm).read();
  expect(options).toEqual({ isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true });
  expect(result.currentStates[0]!.count).toBe('9007199254740993'); expect(result.outbox.oldest_age_seconds).toBe('12.345');
  expect(result.transactionLifecycle.includesReferenceWaiting).toBe(true); expect(statements).toHaveLength(4);
  expect(statements.every(sql => !/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql))).toBe(true);
  expect(statements[1]).toContain('count(DISTINCT'); expect(statements[0]).toContain('"fixture"."wager_transactions"');
  expect(JSON.stringify(result)).not.toContain('walletId');
});
test('database metric failure propagates instead of returning invented zero totals', async () => {
  const failure = new Error('unavailable');
  const orm = { em: { fork: () => ({ transactional: async () => { throw failure; } }) } } as unknown as MikroORM;
  await expect(new PostgresOperationalMetrics(orm).read()).rejects.toBe(failure);
});
