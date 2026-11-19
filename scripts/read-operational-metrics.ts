import { createPersistence } from '../src/database/orm';
import { httpDatabaseConnection } from '../src/http/runtime-persistence';
import { PostgresOperationalMetrics } from '../src/modules/operations/postgres-operational-metrics';
import { jsonLogger } from '../src/modules/operations/json-logger';

async function main() {
  const orm = await createPersistence(httpDatabaseConnection(process.env));
  try {
    console.log(JSON.stringify(await new PostgresOperationalMetrics(orm).read()));
  } finally { await orm.close(true); }
}
void main().catch(() => {
  jsonLogger.emit('error', 'metrics.query_failed');
  process.exitCode = 1;
});
