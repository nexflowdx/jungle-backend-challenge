import { expect, test } from 'bun:test';
import { workerConfiguration, consumerConfiguration } from '../../src/modules/operations/worker-configuration';
import { runWorkerProcess } from '../../src/modules/operations/worker-process';
const env = { PGHOST: 'postgres', PGPORT: '5432', PGDATABASE: 'test', PGUSER: 'test', PGPASSWORD: 'secret',
  SQS_ENDPOINT: 'http://ministack:4566', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
  SQS_QUEUE_URL: 'http://ministack:4566/000000000000/wager-transactions.fifo', SQS_DLQ_URL: 'http://ministack:4566/000000000000/wager-transactions-dlq.fifo' };
test('worker settings enforce long polling, explicit credentials and bounded limits', () => {
  const settings = workerConfiguration(env); expect(settings.waitTimeSeconds).toBe(10); expect(settings.shutdownGraceMs).toBe(30000);
  expect(consumerConfiguration(env, settings).configuration.visibilityTimeout).toBe(120);
});
test.each([{ SQS_WAIT_TIME_SECONDS: '0' }, { SQS_WAIT_TIME_SECONDS: '21' }, { WORKER_SHUTDOWN_GRACE_MS: '0' },
  { WORKER_POLL_INTERVAL_MS: '1' }, { SQS_VISIBILITY_TIMEOUT_SECONDS: '601' }, { SQS_ENDPOINT: 'https://user:secret@host/' }, { AWS_SECRET_ACCESS_KEY: '' }])('invalid worker configuration %# fails before network or processing', patch => {
  expect(() => workerConfiguration({ ...env, ...patch })).toThrow();
});
test('process entrypoint installs both signal handlers and removes them after clean completion', async () => {
  const term = process.listenerCount('SIGTERM'); const interrupt = process.listenerCount('SIGINT');
  await runWorkerProcess(async stop => {
    expect(stop.aborted).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(term + 1); expect(process.listenerCount('SIGINT')).toBe(interrupt + 1);
    return 'stopped';
  }, 1000);
  expect(process.listenerCount('SIGTERM')).toBe(term); expect(process.listenerCount('SIGINT')).toBe(interrupt);
});
