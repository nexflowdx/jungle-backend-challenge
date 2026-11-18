import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PostgresOutboxReservation } from '../../src/modules/messaging/infrastructure/postgres-outbox-reservation';
import { testPersistence } from '../helpers/postgres-wager-fixtures';
import { bounded } from '../helpers/bun-process-client';
import { outboxBarrier, outboxReservationPersistence, withOutboxReservationFixture } from '../helpers/outbox-reservation-fixtures';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
describe.skipIf(!enabled)('Outbox reservation with real PostgreSQL (8.1)', () => {
  let orm: MikroORM; let first: MikroORM; let second: MikroORM;
  beforeAll(async () => {
    orm = await testPersistence(); await orm.getMigrator().up();
    first = await outboxReservationPersistence(); second = await outboxReservationPersistence();
  }, 30000);
  afterAll(async () => { await Promise.all([first?.close(true), second?.close(true), orm?.close(true)]); });
  const reserve = (publisher = first) => new PostgresOutboxReservation(publisher);

  test('returns an empty batch when no own events are eligible', async () => {
    await withOutboxReservationFixture(orm, async () => { expect(await reserve().reserve({ limit: 10 })).toEqual([]); });
  });

  test('filters published, future-scheduled and actively leased events', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const immediate = await f.seed('immediate'); const expired = await f.seed('expired', { dueSeconds: -60, leaseSeconds: -60 });
      const future = await f.seed('future', { dueSeconds: 3600 }); const active = await f.seed('active', { leaseSeconds: 3600 });
      const published = await f.seed('published', { published: true });
      const excluded = await Promise.all([future, active, published].map(id => f.read(id).then(row => structuredClone({ ...row }))));
      expect((await reserve().reserve({ limit: 10 })).map(row => row.id).sort()).toEqual([immediate, expired].sort());
      expect(await Promise.all([future, active, published].map(id => f.read(id).then(row => structuredClone({ ...row }))))).toEqual(excluded);
    });
  });

  test('orders NULL schedules first, then due dates and occurrence/id while bounding batches', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const at = new Date('2026-01-01T00:00:00Z');
      const b = await f.seed('b', { occurredAt: at }); const a = await f.seed('a', { occurredAt: at });
      const later = await f.seed('later', { occurredAt: new Date('2026-01-02T00:00:00Z') });
      const earlierDue = await f.seed('earlier-due', { dueSeconds: -120, occurredAt: new Date('2030-01-01T00:00:00Z') });
      const laterDue = await f.seed('later-due', { dueSeconds: -60, occurredAt: new Date('2020-01-01T00:00:00Z') });
      expect((await reserve().reserve({ limit: 2 })).map(row => row.id)).toEqual([a, b]);
      expect((await reserve().reserve({ limit: 2 })).map(row => row.id)).toEqual([later, earlierDue]);
      expect((await reserve().reserve({ limit: 2 })).map(row => row.id)).toEqual([laterDue]);
    });
  });

  test.each([undefined, 1, 3600].map(leaseSeconds => ({ leaseSeconds })))('preserves event snapshots and derives lease %# from SQL time', async ({ leaseSeconds }) => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('snapshot', { attempts: 2, dueSeconds: -60 }); const before = structuredClone({ ...await f.read(id) });
      const [lower] = await orm.em.fork().execute<{ at: Date }[]>('SELECT clock_timestamp() AS at');
      const result = await reserve().reserve({ limit: 1, ...(leaseSeconds === undefined ? {} : { leaseSeconds }) });
      const [upper] = await orm.em.fork().execute<{ at: Date }[]>('SELECT clock_timestamp() AS at');
      expect(result).toHaveLength(1); const row = result[0]!; const after = await f.read(id);
      expect(row).toMatchObject({ id, aggregateId: before.aggregateId, eventType: before.eventType, eventVersion: before.eventVersion,
        payload: before.payload, occurredAt: before.occurredAt, nextAttemptAt: before.nextAttemptAt, attempts: 3, publishedAt: null });
      expect(row.leaseToken).toMatch(uuidV4); expect(after.leaseToken).toBe(row.leaseToken); expect(after.attempts).toBe(3);
      const duration = (leaseSeconds ?? 30) * 1000;
      expect(row.leaseUntil.getTime()).toBeGreaterThanOrEqual(lower!.at.getTime() + duration);
      expect(row.leaseUntil.getTime()).toBeLessThanOrEqual(upper!.at.getTime() + duration);
      expect(after.leaseUntil).toEqual(row.leaseUntil); expect(after.publishedAt).toBeNull();
    });
  });

  test('a live lease prevents an immediate second grant for the same event', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('live'); expect((await reserve().reserve({ limit: 1 }))[0]!.id).toBe(id);
      expect(await reserve(second).reserve({ limit: 1 })).toEqual([]); expect((await f.read(id)).attempts).toBe(1);
    });
  });

  test('expired leases receive a fresh token and increased attempt count exactly once', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('expired', { leaseSeconds: -60, attempts: 4 }); const previous = await f.read(id);
      const [row] = await reserve().reserve({ limit: 1 });
      expect(row!.id).toBe(id); expect(row!.leaseToken).toMatch(uuidV4); expect(row!.leaseToken).not.toBe(previous.leaseToken);
      expect(row!.attempts).toBe(5); expect(await reserve(second).reserve({ limit: 1 })).toEqual([]);
    });
  });

  test('a real SQL overflow rolls back the entire reservation batch', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const a = await f.seed('a'); const b = await f.seed('b', { attempts: 2147483647 });
      const before = await Promise.all([a, b].map(id => f.read(id).then(row => structuredClone({ ...row }))));
      await expect(reserve().reserve({ limit: 2 })).rejects.toMatchObject({ code: '22003' });
      expect(await Promise.all([a, b].map(id => f.read(id).then(row => structuredClone({ ...row }))))).toEqual(before);
    });
  });

  test('two independent PostgreSQL publishers obtain disjoint bounded grants', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const ids = await Promise.all(['a', 'b', 'c', 'd'].map(id => f.seed(id)));
      const [a] = await first.em.fork().execute<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      const [b] = await second.em.fork().execute<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      expect(new Set([a!.pid, b!.pid, f.backlogBackendPid]).size).toBe(3);
      const start = outboxBarrier();
      const left = start.promise.then(() => reserve().reserve({ limit: 2 })); const right = start.promise.then(() => reserve(second).reserve({ limit: 2 }));
      start.release(); const [one, two] = await Promise.all([left, right]);
      expect(one).toHaveLength(2); expect(two).toHaveLength(2);
      expect([...one, ...two].map(row => row.id).sort()).toEqual(ids.sort());
      expect(new Set([...one, ...two].map(row => row.id)).size).toBe(4);
      expect(new Set([...one, ...two].map(row => row.leaseToken)).size).toBe(4);
      expect(await reserve().reserve({ limit: 4 })).toEqual([]);
      expect(await reserve(second).reserve({ limit: 4 })).toEqual([]);
    });
  });

  test('SKIP LOCKED reserves another event before the competing row lock is released', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const a = await f.seed('a'); const b = await f.seed('b'); const acquired = outboxBarrier(); const release = outboxBarrier();
      const holding = first.em.fork().transactional(async manager => {
        await manager.execute("SET LOCAL lock_timeout='1000ms'");
        await manager.execute('SELECT id FROM outbox_messages WHERE id=? FOR UPDATE', [a]); acquired.release(); await release.promise;
      });
      void holding.catch(() => {}); let running: ReturnType<PostgresOutboxReservation['reserve']> | undefined;
      let failed = false; let originalError: unknown;
      try {
        await bounded(Promise.race([acquired.promise, holding.then(() => { throw new Error('Lock ended early'); })]), 2000, 'held outbox row');
        running = reserve(second).reserve({ limit: 2 });
        expect((await bounded(running, 2000, 'SKIP LOCKED progress')).map(row => row.id)).toEqual([b]);
      } catch (error) { failed = true; originalError = error; throw error; }
      finally {
        release.release();
        const results = await Promise.allSettled(running ? [holding, running] : [holding]);
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
          .filter(error => !failed || error !== originalError);
        if (errors.length) throw new AggregateError(failed ? [originalError, ...errors] : errors,
          'Outbox lock-session cleanup failed', failed ? { cause: originalError } : undefined);
      }
      expect((await reserve().reserve({ limit: 1 }))[0]!.id).toBe(a);
    });
  });

  test('committed reservation releases SQL locks while its lease remains active', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('released'); const [row] = await reserve().reserve({ limit: 1 });
      await second.em.fork().transactional(async manager => {
        const locked = await manager.execute<{ id: string }[]>('SELECT id FROM outbox_messages WHERE id=? FOR UPDATE NOWAIT', [id]);
        expect(locked).toEqual([{ id }]);
      });
      expect((await f.read(id)).leaseToken).toBe(row!.leaseToken);
    });
  });

  test('uncommitted producer events cannot be reserved before their COMMIT', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const inserted = outboxBarrier(); const release = outboxBarrier(); let id = '';
      const producer = first.em.fork().transactional(async manager => { id = await f.seed('uncommitted', {}, manager); inserted.release(); await release.promise; });
      void producer.catch(() => {});
      let failed = false; let originalError: unknown;
      try {
        await bounded(Promise.race([inserted.promise, producer.then(() => { throw new Error('Producer ended early'); })]), 2000, 'uncommitted producer');
        expect(await reserve(second).reserve({ limit: 1 })).toEqual([]);
      } catch (error) { failed = true; originalError = error; throw error; }
      finally {
        release.release();
        try { await producer; }
        catch (error) {
          if (failed && error !== originalError) throw new AggregateError([originalError, error],
            'Outbox producer cleanup failed', { cause: originalError });
          if (!failed) throw error;
        }
      }
      expect((await reserve(second).reserve({ limit: 1 }))[0]!.id).toBe(id);
    });
  });

  test('rolled-back producer events never become reservable', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const error = new Error('Producer rollback');
      await expect(first.em.fork().transactional(async manager => { await f.seed('rollback', {}, manager); throw error; })).rejects.toBe(error);
      expect(await reserve(second).reserve({ limit: 1 })).toEqual([]);
    });
  });
});
