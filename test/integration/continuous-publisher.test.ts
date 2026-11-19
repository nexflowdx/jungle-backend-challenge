import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueUrlCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { ContinuousWorkerClient } from '../helpers/continuous-worker-client';
import { createRetryTestClient } from '../helpers/sqs-retry-fixtures';
import { testPersistence } from '../helpers/postgres-wager-fixtures';
import { withOutboxReservationFixture } from '../helpers/outbox-reservation-fixtures';

describe.skipIf(process.env.PERSISTENCE_INTEGRATION !== '1')('continuous publisher with real PostgreSQL, MiniStack and OS signals', () => {
  let orm: MikroORM; let client: SQSClient;
  beforeAll(async () => { orm = await testPersistence(); await orm.getMigrator().up(); client = await createRetryTestClient(); }, 30000);
  afterAll(async () => { client?.destroy(); await orm?.close(true); });
  async function withQueue(run: (url: string) => Promise<void>) {
    const queueUrl = 'http://ministack:4566/000000000000/wager-events.fifo'; let owned = false;
    try {
      let exists = true;
      try { await client.send(new GetQueueUrlCommand({ QueueName: 'wager-events.fifo' })); }
      catch (error) { if (!(error instanceof Error) || error.name !== 'QueueDoesNotExist') throw error; exists = false; }
      if (exists) throw new Error('Refusing to alter preexisting event queue');
      await client.send(new CreateQueueCommand({ QueueName: 'wager-events.fifo', Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } })); owned = true;
      await run(queueUrl);
    } finally { if (owned) await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl })); }
  }
  const child = (queueUrl: string, mode: string, grace = 1000) => new ContinuousWorkerClient('continuous-publisher-probe', {
    ...process.env, SQS_EVENTS_QUEUE_URL: queueUrl, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
    CONTINUOUS_MODE: mode, CONTINUOUS_GRACE_MS: String(grace),
  });
  test('uncertain send keeps the row pending then retries the same identity without losing or duplicating the event', async () => {
    await withQueue(async queueUrl => withOutboxReservationFixture(orm, async fixture => {
      const id = await fixture.seed('uncertain'); const process = child(queueUrl, 'uncertain');
      try {
        await process.waitFor('retry-scheduled'); const pending = await fixture.read(id);
        expect(pending.publishedAt).toBeNull(); expect(pending.attempts).toBe(1); expect(pending.nextAttemptAt).toBeInstanceOf(Date);
        const first = await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1, MessageSystemAttributeNames: ['All'] }));
        expect(first.Messages).toHaveLength(1); expect(JSON.parse(first.Messages![0]!.Body!).eventId).toBe(id);
        process.release(); await process.waitFor('published'); process.stop(); expect(await process.exited()).toBe(0);
        expect((await fixture.read(id)).publishedAt).toBeInstanceOf(Date); expect((await fixture.read(id)).attempts).toBe(2);
        expect((await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 0 }))).Messages ?? []).toHaveLength(0);
      } finally { await process.close(); }
    }));
  }, 20000);
  test('SIGINT drains an active publication and confirms only after actual send confirmation', async () => {
    await withQueue(async queueUrl => withOutboxReservationFixture(orm, async fixture => {
      const id = await fixture.seed('drain'); const process = child(queueUrl, 'blocked', 3000);
      try {
        await process.waitFor('sending'); expect((await fixture.read(id)).publishedAt).toBeNull();
        process.stop('SIGINT'); await process.waitFor('stopping'); process.release(); await process.waitFor('published');
        expect(await process.exited()).toBe(0); expect((await fixture.read(id)).publishedAt).toBeInstanceOf(Date);
      } finally { await process.close(); }
    }));
  }, 20000);
  test('expired shutdown leaves the lease recoverable; a new publisher confirms the original event', async () => {
    await withQueue(async queueUrl => withOutboxReservationFixture(orm, async fixture => {
      const id = await fixture.seed('expire'); const blocked = child(queueUrl, 'blocked', 50);
      try {
        await blocked.waitFor('sending'); blocked.stop(); expect(await blocked.exited()).toBe(1);
        expect((await fixture.read(id)).publishedAt).toBeNull();
        // Only this dead worker's fixture lease is expired to avoid a 30-second test sleep.
        await orm.em.fork().execute("UPDATE outbox_messages SET lease_until=clock_timestamp()-interval '1 second' WHERE id=?", [id]);
        const recovery = child(queueUrl, 'normal');
        try { await recovery.waitFor('published'); recovery.stop(); expect(await recovery.exited()).toBe(0); }
        finally { await recovery.close(); }
        expect((await fixture.read(id)).publishedAt).toBeInstanceOf(Date); expect((await fixture.read(id)).attempts).toBe(2);
      } finally { await blocked.close(); }
    }));
  }, 20000);
});
