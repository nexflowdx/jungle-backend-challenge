import type { MikroORM } from '@mikro-orm/postgresql';
import { WagerTransactionStatus } from '../domain/wager-transaction.types';

export interface PendingReferenceCandidate {
  readonly id: string;
  readonly walletId: string;
}

export class PostgresPendingReferenceSelector {
  constructor(private readonly orm: MikroORM) {}

  async findDue(limit = 50): Promise<readonly PendingReferenceCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Invalid pending reference batch size');
    }

    const rows = await this.orm.em.fork().getConnection().execute<
      PendingReferenceCandidate[]
    >(
      `SELECT id, wallet_id AS "walletId"
       FROM wager_transactions
       WHERE status = ?
         AND (
           next_reference_attempt_at IS NULL
           OR next_reference_attempt_at <= statement_timestamp()
           OR created_at <= statement_timestamp() - INTERVAL '24 hours'
         )
       ORDER BY next_reference_attempt_at NULLS FIRST, created_at, id
       LIMIT ?`,
      [WagerTransactionStatus.PendingReference, limit],
    );

    return rows.map(row => Object.freeze({
      id: row.id,
      walletId: row.walletId,
    }));
  }
}
