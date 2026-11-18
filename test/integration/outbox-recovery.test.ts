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

describe.skipIf(!enabled)('Outbox recovery after publisher failure (8.3)', () => {
  let orm: MikroORM;
  let first: MikroORM;
  let second: MikroORM;

  beforeAll(async () => {
    orm = await testPersistence();
    await orm.getMigrator().up();
    first = await outboxReservationPersistence();
    second = await outboxReservationPersistence();
  }, 30000);

  afterAll(async () => {
    await Promise.all([
      first?.close(true),
      second?.close(true),
      orm?.close(true),
    ]);
  });

  test('reclaims an abandoned event and rejects the stale publisher', async () => {
    await withOutboxReservationFixture(orm, async fixture => {
      const id = await fixture.seed('abandoned', {
        leaseSeconds: -60,
        attempts: 1,
      });

      const abandoned = await fixture.read(id);
      const staleToken = abandoned.leaseToken!;

      // Simulates the event becoming eligible after publisher A dies.
      const [recovered] = await new PostgresOutboxReservation(second)
        .reserve({ limit: 1, leaseSeconds: 30 });

      expect(recovered).toBeDefined();
      expect(recovered!.id).toBe(id);
      expect(recovered!.leaseToken).not.toBe(staleToken);
      expect(recovered!.attempts).toBe(2);

      // Publisher A must not modify the recovered event.
      expect(await new PostgresOutboxConfirmation(first)
        .confirm(id, staleToken)).toBe(false);

      expect(await new PostgresOutboxRetry(first)
        .schedule(id, staleToken, 1)).toBe(false);

      const active = await fixture.read(id);
      expect(active.leaseToken).toBe(recovered!.leaseToken);
      expect(active.publishedAt).toBeNull();

      // Publisher B can confirm using its current lease.
      expect(await new PostgresOutboxConfirmation(second)
        .confirm(id, recovered!.leaseToken)).toBe(true);

      const published = await fixture.read(id);
      expect(published.publishedAt).toBeInstanceOf(Date);
      expect(published.leaseToken).toBeNull();
      expect(published.leaseUntil).toBeNull();

      expect(await new PostgresOutboxReservation(first)
        .reserve({ limit: 1 })).toEqual([]);
    });
  });
});
