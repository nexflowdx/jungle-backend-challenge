import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PostgresOutboxReservation } from '../../src/modules/messaging/infrastructure/postgres-outbox-reservation';
import { PostgresOutboxConfirmation } from '../../src/modules/messaging/infrastructure/postgres-outbox-confirmation';
import { PostgresOutboxRetry } from '../../src/modules/messaging/infrastructure/postgres-outbox-retry';
import { testPersistence } from '../helpers/postgres-wager-fixtures';
import {
  outboxReservationPersistence,
  withOutboxReservationFixture,
} from '../helpers/outbox-reservation-fixtures';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';

describe.skipIf(!enabled)('Outbox retry with PostgreSQL (8.2)', () => {
  let orm: MikroORM;
  let publisher: MikroORM;

  beforeAll(async () => {
    orm = await testPersistence();
    await orm.getMigrator().up();
    publisher = await outboxReservationPersistence();
  }, 30000);

  afterAll(async () => {
    await Promise.all([publisher?.close(true), orm?.close(true)]);
  });

  const reserve = () => new PostgresOutboxReservation(publisher);
  const retry = () => new PostgresOutboxRetry(publisher);

  test('valid token schedules retry and releases lease', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('valid');
      const [event] = await reserve().reserve({ limit: 1 });

      expect(event!.id).toBe(id);
      expect(await retry().schedule(id, event!.leaseToken, 30)).toBe(true);

      const row = await f.read(id);
      expect(row.publishedAt).toBeNull();
      expect(row.leaseToken).toBeNull();
      expect(row.leaseUntil).toBeNull();
      expect(row.nextAttemptAt).not.toBeNull();
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

      expect(await reserve().reserve({ limit: 1 })).toEqual([]);
    });
  });

  test('incorrect token cannot reschedule an event', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('incorrect');
      await reserve().reserve({ limit: 1 });

      const before = await f.read(id);

      expect(await retry().schedule(id, 'incorrect-token', 30)).toBe(false);
      expect(await f.read(id)).toEqual(before);
    });
  });

  test('expired lease cannot reschedule an event', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('expired', { leaseSeconds: -60 });
      const before = await f.read(id);

      expect(await retry().schedule(id, before.leaseToken!, 30)).toBe(false);
      expect(await f.read(id)).toEqual(before);
    });
  });

  test('old publisher cannot reschedule after a new reservation', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('reclaimed', { leaseSeconds: -60 });
      const oldToken = (await f.read(id)).leaseToken!;

      const [current] = await reserve().reserve({ limit: 1 });

      expect(current!.id).toBe(id);
      expect(current!.leaseToken).not.toBe(oldToken);

      expect(await retry().schedule(id, oldToken, 30)).toBe(false);
      expect((await f.read(id)).leaseToken).toBe(current!.leaseToken);

      expect(await retry().schedule(id, current!.leaseToken, 30)).toBe(true);
    });
  });

  test('published event cannot be rescheduled', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('published');
      const [event] = await reserve().reserve({ limit: 1 });

      expect(await new PostgresOutboxConfirmation(publisher)
        .confirm(id, event!.leaseToken)).toBe(true);

      const before = await f.read(id);

      expect(await retry().schedule(id, event!.leaseToken, 30)).toBe(false);
      expect(await f.read(id)).toEqual(before);
    });
  });
});
