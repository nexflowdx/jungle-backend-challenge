import { createPersistence } from '../src/database/orm';
import { PostgresPendingReferenceSelector } from '../src/modules/wagering/infrastructure/postgres-pending-reference-selector';
import { PostgresWagerProcessingUnitOfWork } from '../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { ProcessPendingReference } from '../src/modules/wagering/application/process-pending-reference';
import { RunPendingReferenceBatch } from '../src/modules/wagering/application/run-pending-reference-batch';
import { jsonLogger } from '../src/modules/operations/json-logger';

async function main(): Promise<void> {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value?.trim()) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
  };

  const port = Number(required('PGPORT'));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid PGPORT');
  }

  const orm = await createPersistence({
    host: required('PGHOST'),
    port,
    dbName: required('PGDATABASE'),
    user: required('PGUSER'),
    password: required('PGPASSWORD'),
  });

  try {
    const selector = new PostgresPendingReferenceSelector(orm);
    const processor = new ProcessPendingReference(
      new PostgresWagerProcessingUnitOfWork(orm),
    );

    const runner = new RunPendingReferenceBatch(selector, processor);
    const result = await runner.execute();

    jsonLogger.emit('info', 'pending_reference.batch_completed');

    if (result.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await orm.close(true);
  }
}

void main().catch(() => {
  jsonLogger.emit('error', 'pending_reference.worker_failed');
  process.exitCode = 1;
});
