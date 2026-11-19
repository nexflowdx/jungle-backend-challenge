import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';

/** Read-only aggregates across instances, based only on currently retained rows. */
export class PostgresOperationalMetrics {
  constructor(private readonly orm: MikroORM) {}
  read() {
    return this.orm.em.fork().transactional(async em => {
      const table = (name: string) => em.getPlatform().quoteIdentifier(`${this.orm.config.get('schema') ?? 'public'}.${name}`);
      const transactions = table('wager_transactions'); const outbox = table('outbox_messages');
      const currentStates = await em.execute<{ status: string; count: string }[]>(
        `SELECT status,count(*)::text AS count FROM ${transactions} GROUP BY status ORDER BY status`);
      const recordedTransitions = await em.execute<{ status: string; count: string }[]>(`
        SELECT payload->'data'->>'status' AS status,count(DISTINCT (payload->'data'->>'transactionId'))::text AS count
        FROM ${outbox} WHERE event_type IN ('WagerTransactionProcessed','WagerTransactionRejected',
          'WagerTransactionPendingReference','WagerTransactionFailed')
          AND payload->'data'->>'transactionId' IS NOT NULL
          AND payload->'data'->>'status' IN ('PROCESSED','REJECTED','PENDING_REFERENCE','FAILED')
        GROUP BY payload->'data'->>'status' ORDER BY status`);
      const [backlog] = await em.execute<{ pending: string; oldest_age_seconds: string }[]>(`
        SELECT count(*)::text AS pending,coalesce(greatest(0,extract(epoch FROM
          (current_timestamp-min(occurred_at)))),0)::text AS oldest_age_seconds FROM ${outbox} WHERE published_at IS NULL`);
      const [lifecycle] = await em.execute<{ completed: string; average_seconds: string | null; maximum_seconds: string | null }[]>(`
        SELECT count(*)::text AS completed,avg(greatest(0,extract(epoch FROM (completed_at-created_at))))::text AS average_seconds,
          max(greatest(0,extract(epoch FROM (completed_at-created_at))))::text AS maximum_seconds
        FROM ${transactions} WHERE completed_at IS NOT NULL`);
      if (!backlog || !lifecycle) throw new Error('Missing operational aggregate');
      return {
        scope: 'database-retained-rows' as const, isolation: 'repeatable read' as const, readOnly: true as const,
        currentStates, recordedTransitions, outbox: backlog,
        transactionLifecycle: { ...lifecycle, includesReferenceWaiting: true as const },
        limitations: ['Historical transitions depend on outbox retention',
          'Lifecycle duration includes waiting and is not per-attempt execution latency',
          'Historical duplicate, transport retry, DLQ and reconciliation observation totals are unavailable'],
      };
    }, { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true });
  }
}
