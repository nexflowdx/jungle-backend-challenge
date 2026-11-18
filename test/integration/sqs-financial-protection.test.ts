import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { InboxMessageRecord } from '../../src/database/entities';
import { ProcessWagerTransaction, type ProcessWagerTransactionResult } from '../../src/modules/wagering/application/process-wager-transaction';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { WagerProcessingRetryableError } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { FailureCode, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';
import { SqsWagerCommandHandler } from '../../src/modules/messaging/application/sqs-wager-command-handler';
import { parseWagerTransactionRequested, type WagerTransactionRequested } from '../../src/modules/messaging/application/wager-requested';
import { wagerMessageIdentity } from '../../src/modules/messaging/application/wager-message-identity';
import type { WagerDeliveryFailure } from '../../src/modules/messaging/application/wager-delivery-policy';
import { SqsWagerDelivery } from '../../src/modules/messaging/infrastructure/sqs-wager-delivery';
import { SqsWagerDlq } from '../../src/modules/messaging/infrastructure/sqs-wager-dlq';
import { SqsWagerRetry } from '../../src/modules/messaging/infrastructure/sqs-wager-retry';
import type { ReceivedRawWagerRequest } from '../../src/modules/messaging/infrastructure/sqs-wager-receiver';
import { assertWalletLedger, openTestWallet, testPersistence, wagerCommand, walletPersistenceSnapshot, type TestWallet } from '../helpers/postgres-wager-fixtures';
import { assertQueueEmptyThrough, createRetryTestClient, observeRetryTransport, releaseForRedelivery, sendRetryBody, waitForRawDelivery, withRetryTestQueues } from '../helpers/sqs-retry-fixtures';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
const statuses = [Status.Processed, Status.Rejected, Status.PendingReference] as const;
type DurableStatus = typeof statuses[number];

describe.skipIf(!enabled)('Financial protection during SQS retry/DLQ (7.3.4B, real PostgreSQL and MiniStack)', () => {
  let orm: MikroORM; let client: SQSClient;
  beforeAll(async () => {
    client = await createRetryTestClient();
    orm = await testPersistence(); await orm.getMigrator().up();
  }, 30000);
  afterAll(async () => { client?.destroy(); if (orm) await orm.close(true); });
  const handler = () => new SqsWagerCommandHandler(new ProcessWagerTransaction(new PostgresWagerProcessingUnitOfWork(orm)));
  function envelope(wallet: TestWallet, status: DurableStatus): WagerTransactionRequested {
    const command = wagerCommand(wallet, status === Status.PendingReference ? Kind.Win : Kind.Bet,
      status === Status.Rejected ? { money: { amount: '101.00', currency: 'BRL' } }
        : status === Status.PendingReference ? { referenceExternalTransactionId: `missing-${randomUUID()}` } : {});
    const { correlationId: _correlationId, causationId: _causationId, ...data } = command;
    return parseWagerTransactionRequested({ messageId: randomUUID(), type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00Z', data });
  }
  const validatedDelivery = (raw: ReceivedRawWagerRequest, event: WagerTransactionRequested) => ({
    sqsMessageId: raw.sqsMessageId!, receiptHandle: raw.receiptHandle!, messageGroupId: raw.messageGroupId!, envelope: event,
  });
  async function persistedState(wallet: TestWallet, event: WagerTransactionRequested, result: ProcessWagerTransactionResult, status: DurableStatus) {
    const expectedBalance = status === Status.Processed ? '75.00' : '100.00';
    await assertWalletLedger(orm, wallet, expectedBalance);
    const financial = await walletPersistenceSnapshot(orm, wallet);
    expect(result.status).toBe(status); expect(result.balance.amount).toBe(expectedBalance);
    const transactions = financial.transactions.filter(row => row.id === result.transactionId);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ status, balance: expectedBalance,
      failureCode: status === Status.Rejected ? FailureCode.InsufficientFunds : null });
    expect(financial.ledger).toHaveLength(status === Status.Processed ? 2 : 1); // Includes opening entry.
    expect(financial.ledger.filter(entry => entry.transactionId === result.transactionId)).toHaveLength(status === Status.Processed ? 1 : 0);
    if (status === Status.PendingReference) expect(transactions[0]).toMatchObject({ acceptedBalance: '100.00', completedAt: null, referenceAttempts: 0 });
    else expect(transactions[0]!.completedAt).toBeInstanceOf(Date);
    const identity = wagerMessageIdentity(event);
    const rows = await orm.em.fork().find(InboxMessageRecord, { messageId: identity.messageId, consumerName: identity.consumerName });
    expect(rows).toHaveLength(1); expect(rows[0]!.processedAt).toBeInstanceOf(Date); expect(rows[0]!.payloadHash).toBe(identity.payloadHash);
    return { financial, inbox: structuredClone({ ...rows[0]! }) };
  }

  test.each(statuses)('durable %s survives ACK failure and exhaustion without DLQ or repeated effects', async status => {
    await withRetryTestQueues(client, async ({ source, dlq }) => {
      const adapter = new SqsWagerDlq(client, source, dlq.queueUrl); await adapter.assertExplicitMode();
      const wallet = await openTestWallet(orm); const event = envelope(wallet, status);
      await sendRetryBody(client, source, JSON.stringify(event));
      let raw = await waitForRawDelivery(client, { ...source, visibilityTimeout: 30 });
      const processor = handler(); let persisted: ProcessWagerTransactionResult | undefined;
      const capture = { execute: async (value: unknown) => { persisted = await processor.execute(value); return persisted; } };
      const failedAck = observeRetryTransport(client, 'ack-before');
      await expect(new SqsWagerDelivery(capture, failedAck.client, source).execute(validatedDelivery(raw, event))).rejects.toBe(failedAck.cause);
      if (!persisted) throw new Error('Expected result from the committed use case before ACK failure');
      const before = await persistedState(wallet, event, persisted, status);
      for (let count = 2; count <= 5; count++) raw = await releaseForRedelivery(client, source, raw);
      expect(raw.approximateReceiveCount).toBe('5');
      const observed = observeRetryTransport(client); const retry = new SqsWagerRetry(observed.client, source, () => 0.5);
      const dlqAdapter = new SqsWagerDlq(observed.client, source, dlq.queueUrl);
      for (const fault of [
        { phase: 'ack', error: failedAck.cause },
        { phase: 'processing', error: new WagerProcessingRetryableError('40001', undefined) },
      ] as const) {
        const failure: WagerDeliveryFailure = { ...fault, financialOutcome: { kind: 'persisted', result: persisted } };
        expect(await retry.apply(raw, failure)).toMatchObject({ kind: 'deferred', decision: { action: 'hold' } });
        expect(await dlqAdapter.apply(raw, failure)).toMatchObject({ kind: 'deferred', decision: { action: 'hold' } });
      }
      expect(observed.trace).toEqual([]); await assertQueueEmptyThrough(client, dlq, Date.now());
      expect(await persistedState(wallet, event, persisted, status)).toEqual(before);
      const replay = await new SqsWagerDelivery(handler(), client, source).execute(validatedDelivery(raw, event));
      expect(replay).toEqual({ ...persisted, idempotentReplay: true });
      expect(await persistedState(wallet, event, replay, status)).toEqual(before);
      await assertQueueEmptyThrough(client, source, Date.now() + 2200);
    });
  });

  test.each(statuses)('simulated lost response after confirmed %s COMMIT holds an uncertain outcome until durable replay', async status => {
    await withRetryTestQueues(client, async ({ source, dlq }) => {
      await new SqsWagerDlq(client, source, dlq.queueUrl).assertExplicitMode();
      const wallet = await openTestWallet(orm); const event = envelope(wallet, status);
      await sendRetryBody(client, source, JSON.stringify(event));
      let raw = await waitForRawDelivery(client, { ...source, visibilityTimeout: 30 });
      const processor = handler(); const lostResponse = new Error('Simulated application response loss AFTER confirmed COMMIT; not a database connection failure');
      let confirmed: ProcessWagerTransactionResult | undefined;
      const responseLoss = { execute: async (value: unknown): Promise<ProcessWagerTransactionResult> => {
        confirmed = await processor.execute(value); // Actual use case resolves after SQL COMMIT, never just its callback.
        throw lostResponse;
      } };
      const observed = observeRetryTransport(client);
      await expect(new SqsWagerDelivery(responseLoss, observed.client, source).execute(validatedDelivery(raw, event))).rejects.toBe(lostResponse);
      if (!confirmed) throw new Error('Test requires a confirmed real COMMIT before simulating response loss');
      // Independent database reads establish the test oracle; the simulated caller is explicitly uncertain.
      const before = await persistedState(wallet, event, confirmed, status);
      for (let count = 2; count <= 5; count++) raw = await releaseForRedelivery(client, source, raw);
      expect(raw.approximateReceiveCount).toBe('5');
      const failure: WagerDeliveryFailure = { phase: 'commit', error: lostResponse, financialOutcome: { kind: 'uncertain' } };
      expect(await new SqsWagerRetry(observed.client, source, () => 0.5).apply(raw, failure))
        .toMatchObject({ kind: 'deferred', decision: { action: 'hold' } });
      expect(await new SqsWagerDlq(observed.client, source, dlq.queueUrl).apply(raw, failure))
        .toMatchObject({ kind: 'deferred', decision: { action: 'hold' } });
      expect(observed.trace).toEqual([]); await assertQueueEmptyThrough(client, dlq, Date.now());
      expect(await persistedState(wallet, event, confirmed, status)).toEqual(before);
      const replay = await new SqsWagerDelivery(handler(), client, source).execute(validatedDelivery(raw, event));
      expect(replay).toEqual({ ...confirmed, idempotentReplay: true });
      expect(await persistedState(wallet, event, replay, status)).toEqual(before);
      await assertQueueEmptyThrough(client, source, Date.now() + 2200);
    });
  });
});
