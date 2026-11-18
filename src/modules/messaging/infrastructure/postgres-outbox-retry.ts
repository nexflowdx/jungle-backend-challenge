import type { MikroORM } from '@mikro-orm/postgresql';
import { runPostgresTransaction } from '../../../database/postgres-transaction';

export class PostgresOutboxRetry {
  constructor(private readonly orm: MikroORM) {}

  async schedule(
    eventId: string,
    leaseToken: string,
    delaySeconds: number,
  ): Promise<boolean> {
    if (
      typeof eventId !== 'string' || !eventId.trim() ||
      typeof leaseToken !== 'string' || !leaseToken.trim() ||
      !Number.isSafeInteger(delaySeconds) ||
      delaySeconds < 1 ||
      delaySeconds > 60
    ) {
      throw new Error('Invalid outbox retry parameters');
    }

    return runPostgresTransaction(this.orm, async manager => {
      const rows = await manager.getConnection().execute<{ id: string }[]>(`
        UPDATE outbox_messages
        SET next_attempt_at = statement_timestamp() + (?::integer * interval '1 second'),
            lease_token = NULL,
            lease_until = NULL
        WHERE id = ?
          AND lease_token = ?
          AND lease_until > statement_timestamp()
          AND published_at IS NULL
        RETURNING id
      `, [delaySeconds, eventId, leaseToken], 'all', manager.getTransactionContext());

      return rows.length === 1;
    });
  }
}
