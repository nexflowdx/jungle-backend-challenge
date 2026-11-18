import type { MikroORM } from '@mikro-orm/postgresql';
import { runPostgresTransaction } from '../../../database/postgres-transaction';

export class PostgresOutboxConfirmation {
  constructor(private readonly orm: MikroORM) {}

  async confirm(eventId: string, leaseToken: string): Promise<boolean> {
    if (typeof eventId !== 'string' || !eventId.trim()
      || typeof leaseToken !== 'string' || !leaseToken.trim()) {
      throw new Error('Invalid outbox confirmation identity');
    }

    return runPostgresTransaction(this.orm, async manager => {
      const rows = await manager.getConnection().execute<{ id: string }[]>(`
        UPDATE outbox_messages
        SET published_at = statement_timestamp(),
            lease_token = NULL,
            lease_until = NULL,
            next_attempt_at = NULL
        WHERE id = ?
          AND lease_token = ?
          AND lease_until > statement_timestamp()
          AND published_at IS NULL
        RETURNING id
      `, [eventId, leaseToken], 'all', manager.getTransactionContext());

      return rows.length === 1;
    });
  }
}
