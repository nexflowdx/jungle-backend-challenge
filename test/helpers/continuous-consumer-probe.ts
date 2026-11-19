import { createInterface } from 'node:readline';
import { DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { assertSqsTestEnvironment } from './sqs-test-environment';
import { createPersistence } from '../../src/database/orm';
import { workerConfiguration, workerSqsClient, consumerConfiguration } from '../../src/modules/operations/worker-configuration';
import { runWorkerProcess } from '../../src/modules/operations/worker-process';
import { createContinuousConsumer } from '../../src/modules/messaging/infrastructure/continuous-sqs-consumer';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import type { WagerProcessingUnitOfWork } from '../../src/modules/wagering/application/wager-processing-unit-of-work';

async function main() {
  assertSqsTestEnvironment(process.env);
  const send = (type: string) => process.stdout.write(JSON.stringify({ type }) + '\n');
  const input = createInterface({ input: process.stdin }); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); input.on('line', line => { if (line === 'release') release(); });
  process.once('SIGTERM', () => { send('stopping'); }); process.once('SIGINT', () => { send('stopping'); });
  const settings = workerConfiguration(process.env); const queues = consumerConfiguration(process.env, settings);
  const grace = Number(process.env.CONTINUOUS_GRACE_MS ?? '1000');
  try {
    await runWorkerProcess(async stop => {
      const orm = await createPersistence(settings.database); const client = workerSqsClient(settings);
      try {
        const base = new PostgresWagerProcessingUnitOfWork(orm); let blocked = false; let ackAttempts = 0;
        const work: WagerProcessingUnitOfWork = { transaction: async callback => {
          const result = await base.transaction(async scope => {
            const value = await callback(scope);
            if (process.env.CONTINUOUS_MODE === 'blocked' && !blocked) { blocked = true; send('processing'); await gate; }
            return value;
          });
          if (process.env.CONTINUOUS_MODE === 'uncertain') { send('uncertain'); throw new Error('Simulated commit response loss'); }
          return result;
        } };
        const observed = new Proxy(client, { get(target, key) {
          if (key !== 'send') return Reflect.get(target, key);
          return async (...args: unknown[]) => {
            if (args[0] instanceof DeleteMessageCommand && process.env.CONTINUOUS_MODE === 'ack-failure' && ++ackAttempts === 1) {
              send('ack-failed'); throw new Error('Simulated ACK failure');
            }
            const response = await Reflect.apply(target.send, target, args);
            if (args[0] instanceof DeleteMessageCommand) send('acked');
            return response;
          };
        } });
        const runtime = createContinuousConsumer(orm, observed, { ...queues.configuration, visibilityTimeout: 2, waitTimeSeconds: 1 }, queues.dlqUrl, work);
        await runtime.preflight(); send('ready');
        const result = await runtime.consumer.run(stop, { intervalMs: 10, shutdownGraceMs: grace });
        if (result === 'timed-out') process.exitCode = 1;
        return result;
      } finally { client.destroy(); await orm.close(true); }
    }, grace);
  } finally { input.close(); process.stdin.destroy(); }
}
void main().catch(() => { process.exitCode = 1; process.stdin.destroy(); });
