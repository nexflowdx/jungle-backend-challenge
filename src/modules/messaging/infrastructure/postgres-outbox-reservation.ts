import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { runPostgresTransaction } from '../../../database/postgres-transaction';
import {
  OutboxReservation, outboxReservationParameters,
  type OutboxReservationOptions, type ReservedOutboxEvent,
} from '../application/outbox-reservation';

type ReservationRow = Omit<ReservedOutboxEvent, 'occurredAt' | 'nextAttemptAt' | 'leaseUntil'> & {
  readonly occurredAt: Date | string;
  readonly nextAttemptAt: Date | string | null;
  readonly leaseUntil: Date | string;
};

function detachedDate(value: Date | string): Date {
  return new Date(typeof value === 'string' ? value : value.getTime());
}

/** Reserves committed events only. No network publication or financial locks/writes. */
export class PostgresOutboxReservation extends OutboxReservation {
  constructor(private readonly orm: MikroORM) { super(); }

  override async reserve(options: OutboxReservationOptions): Promise<readonly ReservedOutboxEvent[]> {
    const { limit, leaseSeconds } = outboxReservationParameters(options);
    const rows = await runPostgresTransaction(this.orm, async manager => {
      const connection = manager.getConnection();
      const context = manager.getTransactionContext();
      const selected = await connection.execute<{ id: string }[]>(`
        SELECT id FROM outbox_messages
        WHERE published_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= statement_timestamp())
          AND (lease_until IS NULL OR lease_until <= statement_timestamp())
        ORDER BY next_attempt_at NULLS FIRST, occurred_at, id
        LIMIT ? FOR UPDATE SKIP LOCKED`, [limit], 'all', context);
      if (selected.length === 0) return [];

      // Each grant gets a fresh token, including reclamation after lease expiry.
      const grants = selected.map(({ id }) => ({ id, token: randomUUID() }));
      const updated = await connection.execute<ReservationRow[]>(`
        UPDATE outbox_messages AS event
        SET attempts = event.attempts + 1,
            lease_token = reservation.token,
            lease_until = statement_timestamp() + (?::integer * interval '1 second')
        FROM jsonb_to_recordset(?::jsonb) AS reservation(id text, token text)
        WHERE event.id = reservation.id
        RETURNING event.id, event.aggregate_id AS "aggregateId", event.event_type AS "eventType",
          event.event_version AS "eventVersion", event.payload, event.occurred_at AS "occurredAt",
          event.attempts, event.next_attempt_at AS "nextAttemptAt", event.published_at AS "publishedAt",
          event.lease_token AS "leaseToken", event.lease_until AS "leaseUntil"`,
      [leaseSeconds, JSON.stringify(grants)], 'all', context);
      if (updated.length !== selected.length) throw new Error('Outbox reservation did not update every locked event');
      const byId = new Map(updated.map(row => [row.id, row]));
      // UPDATE RETURNING does not promise the SELECT ordering.
      return selected.map(({ id }) => {
        const row = byId.get(id);
        if (!row) throw new Error('Outbox reservation lost a locked event');
        return row;
      });
    });

    // No grant escapes before COMMIT, and no ORM identity-map object escapes at all.
    return Object.freeze(rows.map(row => Object.freeze({
      ...row, payload: Object.freeze(structuredClone(row.payload)),
      occurredAt: detachedDate(row.occurredAt),
      nextAttemptAt: row.nextAttemptAt === null ? null : detachedDate(row.nextAttemptAt),
      leaseUntil: detachedDate(row.leaseUntil),
    })));
  }
}
