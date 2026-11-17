import type { MikroORM } from '@mikro-orm/postgresql';
import { runPostgresTransaction } from '../../../database/postgres-transaction';
import { WagerProcessingUnitOfWork } from '../application/wager-processing-unit-of-work';

export class PostgresWagerProcessingUnitOfWork extends WagerProcessingUnitOfWork {
  constructor(private readonly orm: MikroORM) { super(); }

  override transaction<T>(work: () => Promise<T>): Promise<T> {
    return runPostgresTransaction(this.orm, () => work());
  }
}
