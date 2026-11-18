import { randomUUID } from 'node:crypto';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { databaseOptions } from '../../src/database/orm';
import { OutboxMessageRecord } from '../../src/database/entities';
import { assertPersistenceTestEnvironment } from '../integration/environment';
import { bounded } from './bun-process-client';

export function outboxReservationPersistence(): Promise<MikroORM> {
  assertPersistenceTestEnvironment(process.env);
  return MikroORM.init({ ...databaseOptions({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test',
    user: 'diagnostic', password: process.env.PGPASSWORD! }), pool: { min: 1, max: 1 } });
}

export function outboxBarrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

interface SeedOptions {
  readonly occurredAt?: Date;
  readonly dueSeconds?: number;
  readonly leaseSeconds?: number;
  readonly attempts?: number;
  readonly published?: boolean;
}
export interface OutboxReservationFixture {
  readonly backlogBackendPid: number;
  seed(suffix: string, options?: SeedOptions, manager?: EntityManager): Promise<string>;
  read(id: string): Promise<OutboxMessageRecord>;
}

/** The production reservation remains global. Only the fixture holds preexisting unpublished
 * rows locked, so SKIP LOCKED isolates both positive and negative cases without deleting backlog.
 * Tests using this helper must run sequentially; only their controlled reservers overlap.
 */
export async function withOutboxReservationFixture(orm: MikroORM, run: (fixture: OutboxReservationFixture) => Promise<void>): Promise<void> {
  assertPersistenceTestEnvironment(process.env);
  const ids: string[] = []; const prefix = randomUUID();
  const acquired = outboxBarrier(); const release = outboxBarrier(); let backlogBackendPid = 0;
  const blocker = orm.em.fork().transactional(async manager => {
    await manager.execute("SET LOCAL lock_timeout='1000ms'");
    await manager.execute('SELECT id FROM outbox_messages WHERE published_at IS NULL FOR UPDATE');
    const [row] = await manager.execute<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
    backlogBackendPid = row!.pid; acquired.release(); await release.promise;
  });
  void blocker.catch(() => {});
  let failed = false; let originalError: unknown;
  try {
    await bounded(Promise.race([acquired.promise, blocker.then(() => { throw new Error('Backlog lock ended before fixture acquisition'); })]), 4000, 'outbox backlog lock');
    await run({ backlogBackendPid,
      seed: async (suffix, options = {}, manager = orm.em.fork()) => {
        const id = `${prefix}-${suffix}`; ids.push(id);
        const occurredAt = options.occurredAt ?? new Date('2026-01-01T00:00:00Z');
        const payload = { eventId: id, aggregateId: `fixture-${prefix}`, eventType: 'ReservationTestEvent', version: 1,
          correlationId: prefix, occurredAt: occurredAt.toISOString(), data: { money: { amount: '25.00', currency: 'BRL' } } };
        const leaseToken = options.leaseSeconds === undefined ? null : randomUUID();
        await manager.execute(`INSERT INTO outbox_messages
          (id,aggregate_id,event_type,event_version,payload,occurred_at,attempts,next_attempt_at,published_at,lease_token,lease_until)
          VALUES (?,?,?,1,?::jsonb,?,?,
            CASE WHEN ?::integer IS NULL THEN NULL ELSE clock_timestamp()+(?::integer*interval '1 second') END,
            CASE WHEN ? THEN clock_timestamp() ELSE NULL END,?,
            CASE WHEN ?::integer IS NULL THEN NULL ELSE clock_timestamp()+(?::integer*interval '1 second') END)`,
        [id, `fixture-${prefix}`, 'ReservationTestEvent', JSON.stringify(payload), occurredAt, options.attempts ?? 0,
          options.dueSeconds ?? null, options.dueSeconds ?? null, options.published ?? false, leaseToken,
          options.leaseSeconds ?? null, options.leaseSeconds ?? null]);
        return id;
      },
      read: id => orm.em.fork().findOneOrFail(OutboxMessageRecord, id),
    });
  } catch (error) { failed = true; originalError = error; throw error; }
  finally {
    release.release(); const cleanupErrors: unknown[] = [];
    try { await blocker; } catch (error) { cleanupErrors.push(error); }
    try { if (ids.length) await orm.em.fork().nativeDelete(OutboxMessageRecord, { id: { $in: ids } }); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(failed ? [originalError, ...cleanupErrors] : cleanupErrors,
      'Outbox fixture cleanup failed', failed ? { cause: originalError } : undefined);
  }
}
