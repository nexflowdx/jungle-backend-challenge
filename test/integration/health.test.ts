import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { testPersistence } from '../helpers/postgres-wager-fixtures';
import { assertSqsTestEnvironment } from '../helpers/sqs-test-environment';
import { createHttpPersistence } from '../../src/http/runtime-persistence';
import { createHttpApplication } from '../../src/http/http-api.module';
import { JsonLogger } from '../../src/modules/operations/json-logger';
import { httpRequest } from '../helpers/http-request';

describe.skipIf(process.env.PERSISTENCE_INTEGRATION !== '1')('health with real PostgreSQL and MiniStack', () => {
  let orm: MikroORM;
  beforeAll(async () => { assertSqsTestEnvironment(process.env); orm = await testPersistence(); await orm.getMigrator().up(); }, 30000);
  afterAll(async () => { await orm?.close(true); });
  const counts = () => orm.em.fork().execute(`SELECT
    (SELECT count(*)::text FROM wallets) AS wallets,(SELECT count(*)::text FROM wallet_ledger_entries) AS ledger,
    (SELECT count(*)::text FROM wager_transactions) AS transactions,(SELECT count(*)::text FROM inbox_messages) AS inbox,
    (SELECT count(*)::text FROM outbox_messages) AS outbox`);
  async function start(endpoint: string) {
    const persistence = await createHttpPersistence({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test', user: 'diagnostic', password: process.env.PGPASSWORD! },
      { SQS_ENDPOINT: endpoint, AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' });
    const application = await createHttpApplication(persistence, { logger: false }, undefined, new JsonLogger(() => {}));
    await application.init(); return application;
  }
  test('real dependency probes return ready without financial writes or authorization', async () => {
    const before = await counts(); const application = await start('http://ministack:4566');
    try {
      expect(await httpRequest(application, '/health/ready', undefined, [], undefined, 'GET'))
        .toEqual({ status: 200, body: { status: 'ready', checks: { postgres: 'up', sqs: 'up' } } });
      expect(await httpRequest(application, '/health/live', undefined, [], undefined, 'GET')).toEqual({ status: 200, body: { status: 'alive' } });
      expect(await counts()).toEqual(before);
    } finally { await application.close(); }
  });
  test('actual SQS connection failure returns sanitized 503 while PostgreSQL and liveness remain up', async () => {
    const application = await start('http://127.0.0.1:1');
    try {
      expect(await httpRequest(application, '/health/ready', undefined, [], undefined, 'GET'))
        .toEqual({ status: 503, body: { status: 'not_ready', checks: { postgres: 'up', sqs: 'down' } } });
      expect((await httpRequest(application, '/health/live', undefined, [], undefined, 'GET')).status).toBe(200);
    } finally { await application.close(); }
  });
});
