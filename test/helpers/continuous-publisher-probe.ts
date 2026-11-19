import { createInterface } from 'node:readline';
import { assertSqsTestEnvironment } from './sqs-test-environment';
import { createPersistence } from '../../src/database/orm';
import { workerConfiguration, workerSqsClient } from '../../src/modules/operations/worker-configuration';
import { runWorkerProcess } from '../../src/modules/operations/worker-process';
import { ContinuousOutboxPublisher, outboxClientWithDeadline } from '../../src/modules/messaging/infrastructure/continuous-outbox-publisher';
import { createOutboxCoordinator } from '../../src/modules/messaging/infrastructure/create-outbox-coordinator';
import type { SqsOutboxSendClient } from '../../src/modules/messaging/infrastructure/sqs-outbox-publisher';

async function main() {
  assertSqsTestEnvironment(process.env);
  const send = (type: string) => process.stdout.write(JSON.stringify({ type }) + '\n');
  const input = createInterface({ input: process.stdin }); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); input.on('line', line => { if (line === 'release') release(); });
  process.once('SIGTERM', () => { send('stopping'); }); process.once('SIGINT', () => { send('stopping'); });
  const settings = workerConfiguration(process.env); const grace = Number(process.env.CONTINUOUS_GRACE_MS ?? '1000');
  const mode = process.env.CONTINUOUS_MODE; const queueUrl = process.env.SQS_EVENTS_QUEUE_URL!;
  try {
    await runWorkerProcess(async stop => {
      const orm = await createPersistence(settings.database); const client = workerSqsClient(settings); let sends = 0;
      try {
        const observed: SqsOutboxSendClient = { send: async (command, options) => {
          sends++;
          if (mode === 'blocked' && sends === 1) { send('sending'); await gate; }
          const result = await client.send(command, options);
          if (mode === 'uncertain' && sends === 1) { send('sent-uncertain'); throw new Error('Simulated publication response loss'); }
          return result;
        } };
        const publisher = new ContinuousOutboxPublisher(async deadline => {
          const result = await createOutboxCoordinator(orm, outboxClientWithDeadline(observed, deadline), queueUrl).processOnce();
          send(result.status);
          if (mode === 'uncertain' && result.status === 'retry-scheduled') await gate;
          return result;
        });
        send('ready');
        return await publisher.run(stop, { intervalMs: 10, shutdownGraceMs: grace });
      } finally { client.destroy(); await orm.close(true); }
    }, grace);
  } finally { input.close(); process.stdin.destroy(); }
}
void main().catch(() => { process.exitCode = 1; process.stdin.destroy(); });
