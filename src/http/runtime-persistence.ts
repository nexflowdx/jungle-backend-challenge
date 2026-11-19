import { createPersistence, type DatabaseConnection } from '../database/orm';
import { PostgresWalletOpeningUnitOfWork } from '../modules/wallets/infrastructure/postgres-wallet-opening-unit-of-work';
import { PostgresWagerProcessingUnitOfWork } from '../modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import type { HttpPersistence } from './http-api.module';
import { PostgresWalletLedgerReader } from '../modules/wallets/infrastructure/postgres-wallet-ledger-reader';
import { PostgresWalletReconciliationSource } from '../modules/wallets/infrastructure/postgres-wallet-reconciliation-source';
import { ReadinessService } from '../modules/operations/readiness';
import { createSqsReadiness } from '../modules/operations/sqs-readiness';

export function httpDatabaseConnection(env: Record<string, string | undefined>): DatabaseConnection {
  const required = (key: string) => { const value = env[key]; if (!value || !value.trim()) throw new Error(`Missing database configuration: ${key}`); return value; };
  const port = required('PGPORT');
  if (!/^[0-9]+$/.test(port) || !Number.isSafeInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid PGPORT');
  return { host: required('PGHOST'), port: Number(port), dbName: required('PGDATABASE'), user: required('PGUSER'), password: required('PGPASSWORD') };
}
export async function createHttpPersistence(connection: DatabaseConnection, env: Record<string, string | undefined> = process.env): Promise<HttpPersistence> {
  const orm = await createPersistence(connection);
  const sqs = createSqsReadiness(env);
  const readiness = new ReadinessService({ postgres: async () => { await orm.em.fork().execute('SELECT 1'); }, sqs: sqs.probe });
  return { walletOpening: new PostgresWalletOpeningUnitOfWork(orm), wagerProcessing: new PostgresWagerProcessingUnitOfWork(orm),
    walletLedger: new PostgresWalletLedgerReader(orm), walletReconciliation: new PostgresWalletReconciliationSource(orm), readiness,
    close: async () => { try { sqs.close(); } finally { await orm.close(true); } } };
}
