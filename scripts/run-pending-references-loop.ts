import { createPersistence } from '../src/database/orm';
import { PostgresPendingReferenceSelector } from '../src/modules/wagering/infrastructure/postgres-pending-reference-selector';
import { PostgresWagerProcessingUnitOfWork } from '../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { ProcessPendingReference } from '../src/modules/wagering/application/process-pending-reference';
import { RunPendingReferenceBatch } from '../src/modules/wagering/application/run-pending-reference-batch';

const INTERVAL_MS = 60_000;
let stopping = false;

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

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
    const runner = new RunPendingReferenceBatch(
      new PostgresPendingReferenceSelector(orm),
      new ProcessPendingReference(new PostgresWagerProcessingUnitOfWork(orm)),
    );

    while (!stopping) {
      const startedAt = Date.now();
      const result = await runner.execute();

      console.log('Pending reference batch:', JSON.stringify(result));

      if (result.failed > 0) {
        process.exitCode = 1;
        break;
      }

      const remaining = Math.max(0, INTERVAL_MS - (Date.now() - startedAt));
      const deadline = Date.now() + remaining;

      while (!stopping && Date.now() < deadline) {
        await Bun.sleep(Math.min(1000, deadline - Date.now()));
      }
    }
  } finally {
    await orm.close(true);
  }
}

void main().catch((error) => {
  console.error('Pending reference worker failed:', error);
  process.exitCode = 1;
});
