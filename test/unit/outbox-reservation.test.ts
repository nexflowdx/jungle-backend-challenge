import { expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InvalidOutboxReservationError, outboxReservationParameters, type OutboxReservationOptions } from '../../src/modules/messaging/application/outbox-reservation';
import { PostgresOutboxReservation } from '../../src/modules/messaging/infrastructure/postgres-outbox-reservation';

function barrier() {
  let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function memoryDatabase(ids: string[], options: { commit?: () => Promise<void>; incomplete?: boolean } = {}) {
  const sourceRows: Array<Record<string, unknown>> = []; let statements = 0;
  const manager = { getTransactionContext: () => undefined, getConnection: () => ({ execute: async (_query: string, parameters: unknown[]) => {
    statements++;
    if (statements === 1) return ids.map(id => ({ id }));
    const grants = JSON.parse(parameters[1] as string) as Array<{ id: string; token: string }>;
    sourceRows.push(...grants.map(grant => ({ id: grant.id, aggregateId: 'wallet', eventType: 'Event', eventVersion: 1,
      payload: { eventId: grant.id, nested: { value: 'original' } }, occurredAt: new Date('2026-01-01T00:00:00Z'),
      attempts: 1, nextAttemptAt: null, publishedAt: null, leaseToken: grant.token, leaseUntil: new Date('2026-01-01T00:00:30Z') })));
    return options.incomplete ? sourceRows.slice(1) : [...sourceRows].reverse();
  } }) };
  const orm = { em: { fork: () => ({ transactional: async (work: (scope: typeof manager) => Promise<unknown>) => {
    const result = await work(manager); await options.commit?.(); return result;
  } }) } } as unknown as MikroORM;
  return { adapter: new PostgresOutboxReservation(orm), sourceRows, statementCount: () => statements };
}

test('outbox reservation defaults to a 30-second lease and returns immutable parameters', () => {
  const parameters = outboxReservationParameters({ limit: 1 });
  expect(parameters).toEqual({ limit: 1, leaseSeconds: 30 }); expect(Object.isFrozen(parameters)).toBe(true);
});

test.each([{ limit: 1, leaseSeconds: 1 }, { limit: 100, leaseSeconds: 3600 }])('outbox reservation accepts documented boundaries %#', options => {
  expect(outboxReservationParameters(options)).toEqual(options);
});

const invalid = [
  ...[undefined, null, 0, -1, 101, 1.5, NaN, Infinity, '1'].map(limit => ({ options: { limit }, field: 'limit' })),
  ...[null, 0, -1, 3601, 1.5, NaN, Infinity, '30'].map(leaseSeconds => ({ options: { limit: 1, leaseSeconds }, field: 'leaseSeconds' })),
  ...[null, undefined, [], 'options'].map(options => ({ options, field: 'limit' })),
];
test.each(invalid)('invalid reservation %# fails before accessing PostgreSQL', async ({ options, field }) => {
  let accesses = 0;
  const orm = { em: { fork: () => { accesses++; throw new Error('Invalid parameters must not acquire a manager'); } } } as unknown as MikroORM;
  await expect(new PostgresOutboxReservation(orm).reserve(options as OutboxReservationOptions)).rejects.toBeInstanceOf(InvalidOutboxReservationError);
  await expect(new PostgresOutboxReservation(orm).reserve(options as OutboxReservationOptions)).rejects.toMatchObject({ field, code: 'INVALID_OUTBOX_RESERVATION' });
  expect(accesses).toBe(0);
});

test('an empty selection returns an empty batch without issuing an update', async () => {
  const database = memoryDatabase([]);
  expect(await database.adapter.reserve({ limit: 1 })).toEqual([]); expect(database.statementCount()).toBe(1);
});

test('reservation grants remain unavailable until the transaction COMMIT resolves', async () => {
  const reached = barrier(); const commit = barrier(); let settled = false;
  const database = memoryDatabase(['event'], { commit: async () => { reached.release(); await commit.promise; } });
  const pending = database.adapter.reserve({ limit: 1 }); void pending.then(() => { settled = true; });
  try { await reached.promise; expect(settled).toBe(false); }
  finally { commit.release(); }
  expect(await pending).toHaveLength(1);
});

test('a failed COMMIT propagates without returning a successful reservation', async () => {
  const cause = new Error('COMMIT outcome unavailable');
  const database = memoryDatabase(['event'], { commit: async () => { throw cause; } });
  await expect(database.adapter.reserve({ limit: 1 })).rejects.toBe(cause);
});

test('snapshots preserve selection order and detach payloads and dates from driver objects', async () => {
  const database = memoryDatabase(['first', 'second']);
  const result = await database.adapter.reserve({ limit: 2 });
  expect(result.map(row => row.id)).toEqual(['first', 'second']); expect(Object.isFrozen(result)).toBe(true);
  const source = database.sourceRows[0]!;
  (source.payload as { nested: { value: string } }).nested.value = 'changed'; (source.occurredAt as Date).setUTCFullYear(2000);
  expect(result[0]!.payload).toMatchObject({ nested: { value: 'original' } }); expect(result[0]!.occurredAt.getUTCFullYear()).toBe(2026);
});

test('an incomplete database reservation update fails closed', async () => {
  const database = memoryDatabase(['first', 'second'], { incomplete: true });
  await expect(database.adapter.reserve({ limit: 2 })).rejects.toThrow('did not update every locked event');
});
