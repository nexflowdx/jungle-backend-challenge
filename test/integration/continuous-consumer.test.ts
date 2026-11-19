import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ReceiveMessageCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { ContinuousWorkerClient } from '../helpers/continuous-worker-client';
import { createRetryTestClient, withRetryTestQueues, waitForRawDelivery } from '../helpers/sqs-retry-fixtures';
import { openTestWallet, testPersistence, wagerCommand, walletPersistenceSnapshot, assertWalletLedger } from '../helpers/postgres-wager-fixtures';
import { InboxMessageRecord } from '../../src/database/entities';

describe.skipIf(process.env.PERSISTENCE_INTEGRATION !== '1')('continuous consumer with real PostgreSQL, MiniStack and OS signals', () => {
  let orm: MikroORM; let client: SQSClient;
  beforeAll(async () => { orm = await testPersistence(); await orm.getMigrator().up(); client = await createRetryTestClient(); }, 30000);
  afterAll(async () => { client?.destroy(); await orm?.close(true); });
  const child = (queueUrl: string, dlqUrl: string, mode: string, grace = 1000) => new ContinuousWorkerClient('continuous-consumer-probe', {
    ...process.env, SQS_QUEUE_URL: queueUrl, SQS_DLQ_URL: dlqUrl, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
    SQS_WAIT_TIME_SECONDS: '1', CONTINUOUS_MODE: mode, CONTINUOUS_GRACE_MS: String(grace),
  });
  const envelope = (command: ReturnType<typeof wagerCommand>) => {
    const { correlationId: _correlation, causationId: _causation, ...data } = command;
    return { messageId: randomUUID(), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };
  };
  const publish = (queueUrl: string, body: unknown) => client.send(new SendMessageCommand({ QueueUrl: queueUrl,
    MessageBody: JSON.stringify(body), MessageGroupId: 'group', MessageDeduplicationId: randomUUID() }));

  test('SIGTERM before commit drains the active transaction and ACKs only after commit', async () => {
    await withRetryTestQueues(client, async ({ source, dlq }) => {
      const wallet = await openTestWallet(orm); await publish(source.queueUrl, envelope(wagerCommand(wallet)));
      const process = child(source.queueUrl, dlq.queueUrl, 'blocked', 3000);
      try {
        await process.waitFor('processing'); expect((await walletPersistenceSnapshot(orm, wallet)).wallet.balance).toBe('100.00');
        process.stop(); await process.waitFor('stopping'); process.stop(); process.release(); await process.waitFor('acked'); expect(await process.exited()).toBe(0);
        await assertWalletLedger(orm, wallet, '75.00');
        expect((await client.send(new ReceiveMessageCommand({ QueueUrl: source.queueUrl, WaitTimeSeconds: 0 }))).Messages ?? []).toHaveLength(0);
      } finally { await process.close(); }
    });
  }, 20000);
  test('expired shutdown before commit retains the message and another process applies it once', async () => {
    await withRetryTestQueues(client, async ({ source, dlq }) => {
      const wallet = await openTestWallet(orm); await publish(source.queueUrl, envelope(wagerCommand(wallet)));
      const blocked = child(source.queueUrl, dlq.queueUrl, 'blocked', 50);
      try {
        await blocked.waitFor('processing'); blocked.stop(); expect(await blocked.exited()).toBe(1);
        expect((await walletPersistenceSnapshot(orm, wallet)).wallet.balance).toBe('100.00');
        const recovery = child(source.queueUrl, dlq.queueUrl, 'normal');
        try { await recovery.waitFor('acked'); recovery.stop(); expect(await recovery.exited()).toBe(0); }
        finally { await recovery.close(); }
        await assertWalletLedger(orm, wallet, '75.00');
      } finally { await blocked.close(); }
    });
  }, 20000);
  test('uncertain ACK redelivers to the same loop without another debit and SIGINT stops pending polling', async () => {
    await withRetryTestQueues(client, async ({ source, dlq }) => {
      const wallet = await openTestWallet(orm); const message = envelope(wagerCommand(wallet)); await publish(source.queueUrl, message);
      const process = child(source.queueUrl, dlq.queueUrl, 'ack-failure');
      try {
        await process.waitFor('ack-failed'); await process.waitFor('acked'); process.stop('SIGINT'); expect(await process.exited()).toBe(0);
        await assertWalletLedger(orm, wallet, '75.00');
        expect(await orm.em.fork().count(InboxMessageRecord, { messageId: message.messageId })).toBe(1);
      } finally { await process.close(); }
    });
  }, 20000);
  test('permanent processing failure reaches DLQ only after actual rollback evidence', async () => {
    await withRetryTestQueues(client, async ({ source, dlq }) => {
      const missing = { id: randomUUID(), playerId: randomUUID(), balance: { amount: '100.00', currency: 'BRL' } };
      const message = envelope(wagerCommand(missing)); await publish(source.queueUrl, message);
      const process = child(source.queueUrl, dlq.queueUrl, 'normal');
      try {
        await process.waitFor('acked'); process.stop(); expect(await process.exited()).toBe(0);
        const received = await waitForRawDelivery(client, dlq); expect(JSON.parse(received.body!)).toEqual(message);
        expect(await orm.em.fork().count(InboxMessageRecord, { messageId: message.messageId })).toBe(0);
      } finally { await process.close(); }
    });
  }, 20000);
  test('lost commit response never sends the already-applied operation to DLQ or ACK', async () => {
    await withRetryTestQueues(client, async ({ source, dlq }) => {
      const wallet = await openTestWallet(orm); const message = envelope(wagerCommand(wallet)); await publish(source.queueUrl, message);
      const process = child(source.queueUrl, dlq.queueUrl, 'uncertain');
      try {
        await process.waitFor('uncertain'); process.stop(); expect(await process.exited()).toBe(0);
        await assertWalletLedger(orm, wallet, '75.00');
        const redelivery = await waitForRawDelivery(client, source); expect(JSON.parse(redelivery.body!)).toEqual(message);
        expect((await client.send(new ReceiveMessageCommand({ QueueUrl: dlq.queueUrl, WaitTimeSeconds: 0 }))).Messages ?? []).toHaveLength(0);
      } finally { await process.close(); }
    });
  }, 20000);
});
