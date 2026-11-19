import { createPersistence } from '../src/database/orm';
import { workerConfiguration, workerSqsClient } from '../src/modules/operations/worker-configuration';
import { runWorkerProcess } from '../src/modules/operations/worker-process';
import { createContinuousPublisher } from '../src/modules/messaging/infrastructure/continuous-outbox-publisher';
import { jsonLogger } from '../src/modules/operations/json-logger';

async function main() {
  const settings = workerConfiguration(process.env);
  const queueUrl = process.env.SQS_EVENTS_QUEUE_URL;
  if (!queueUrl) throw new Error('Missing outbox queue URL');
  await runWorkerProcess(async stop => {
    const orm = await createPersistence(settings.database); const client = workerSqsClient(settings);
    try {
      const publisher = createContinuousPublisher(orm, client, queueUrl);
      const result = await publisher.run(stop, settings);
      if (result === 'timed-out') process.exitCode = 1;
      return result;
    } finally { client.destroy(); await orm.close(true); }
  }, settings.shutdownGraceMs);
}
void main().catch(() => { jsonLogger.emit('error', 'worker.failed'); process.exitCode = 1; });
