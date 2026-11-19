import { createPersistence } from '../src/database/orm';
import { workerConfiguration, workerSqsClient, consumerConfiguration } from '../src/modules/operations/worker-configuration';
import { runWorkerProcess } from '../src/modules/operations/worker-process';
import { createContinuousConsumer } from '../src/modules/messaging/infrastructure/continuous-sqs-consumer';
import { jsonLogger } from '../src/modules/operations/json-logger';

async function main() {
  const settings = workerConfiguration(process.env); const queues = consumerConfiguration(process.env, settings);
  await runWorkerProcess(async stop => {
    const orm = await createPersistence(settings.database); const client = workerSqsClient(settings);
    try {
      if (stop.aborted) return;
      const runtime = createContinuousConsumer(orm, client, queues.configuration, queues.dlqUrl);
      await runtime.preflight();
      const result = await runtime.consumer.run(stop, settings);
      if (result === 'timed-out') process.exitCode = 1;
      return result;
    } finally { client.destroy(); await orm.close(true); }
  }, settings.shutdownGraceMs);
}
void main().catch(() => { jsonLogger.emit('error', 'worker.failed'); process.exitCode = 1; });
