import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PostgresOutboxReservation } from '../../src/modules/messaging/infrastructure/postgres-outbox-reservation';
import { PostgresOutboxConfirmation } from '../../src/modules/messaging/infrastructure/postgres-outbox-confirmation';
import { testPersistence } from '../helpers/postgres-wager-fixtures';
import { outboxReservationPersistence, withOutboxReservationFixture } from '../helpers/outbox-reservation-fixtures';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';

describe.skipIf(!enabled)('Outbox publication confirmation with PostgreSQL (8.2)', () => {
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
  const confirm = () => new PostgresOutboxConfirmation(publisher);

  test('valid token confirms publication and releases lease', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('valid');
      const [event] = await reserve().reserve({ limit: 1 });

      expect(event!.id).toBe(id);
      expect(await confirm().confirm(id, event!.leaseToken)).toBe(true);

      const row = await f.read(id);
      expect(row.publishedAt).not.toBeNull();
      expect(row.leaseToken).toBeNull();
      expect(row.leaseUntil).toBeNull();
      expect(row.nextAttemptAt).toBeNull();
      expect(await reserve().reserve({ limit: 1 })).toEqual([]);
    });
  });

  test('incorrect token cannot confirm publication', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('incorrect');
      const [event] = await reserve().reserve({ limit: 1 });
      const before = await f.read(id);

      expect(await confirm().confirm(id, 'incorrect-token')).toBe(false);
      expect(await f.read(id)).toEqual(before);
      expect(event!.leaseToken).toBe(before.leaseToken!);
    });
  });

  test('expired lease cannot confirm publication', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('expired', { leaseSeconds: -60 });
      const previous = await f.read(id);

      expect(await confirm().confirm(id, previous.leaseToken!)).toBe(false);
      expect(await f.read(id)).toEqual(previous);
    });
  });

  test('old publisher cannot confirm after a new reservation', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('reclaimed', { leaseSeconds: -60 });
      const oldToken = (await f.read(id)).leaseToken!;
      const [current] = await reserve().reserve({ limit: 1 });

      expect(current!.id).toBe(id);
      expect(current!.leaseToken).not.toBe(oldToken);
      expect(await confirm().confirm(id, oldToken)).toBe(false);
      expect((await f.read(id)).leaseToken).toBe(current!.leaseToken);
      expect(await confirm().confirm(id, current!.leaseToken)).toBe(true);
    });
  });

  test('publication cannot be confirmed twice', async () => {
    await withOutboxReservationFixture(orm, async f => {
      const id = await f.seed('once');
      const [event] = await reserve().reserve({ limit: 1 });

      expect(await confirm().confirm(id, event!.leaseToken)).toBe(true);
      const published = await f.read(id);

      expect(await confirm().confirm(id, event!.leaseToken)).toBe(false);
      expect(await f.read(id)).toEqual(published);
    });
  });
});
