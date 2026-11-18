import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueAttributesCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { SqsWagerReceiver } from '../../src/modules/messaging/infrastructure/sqs-wager-receiver';
import { SqsWagerRetry } from '../../src/modules/messaging/infrastructure/sqs-wager-retry';
import { SqsWagerDlq } from '../../src/modules/messaging/infrastructure/sqs-wager-dlq';
import { InvalidWagerMessageError } from '../../src/modules/messaging/application/wager-requested';
import type { WagerDeliveryFailure } from '../../src/modules/messaging/application/wager-delivery-policy';
import { WagerProcessingRetryableError } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import {
  assertQueueEmptyThrough, createRetryTestClient, observeRetryTransport, receiveDlqMessage,
  releaseForRedelivery, sendRetryBody, waitForRawDelivery, withRetryTestQueues,
} from '../helpers/sqs-retry-fixtures';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
const body = '  { invalid JSON: "ação"\n';
const permanent: WagerDeliveryFailure = { phase: 'validation', error: new InvalidWagerMessageError(), financialOutcome: { kind: 'not-started' } };
// Transport-policy input only: no financial transaction/rollback is claimed by this SQS-only suite.
const transient: WagerDeliveryFailure = { phase: 'processing', error: new WagerProcessingRetryableError('40001', undefined), financialOutcome: { kind: 'rolled-back' } };

// Same explicit integration gate as 7.2. Unsupported emulator behavior fails; it never triggers a skip/fallback.
describe.skipIf(!enabled)('Explicit SQS retry and DLQ (7.3.4A, MiniStack 1.5.39)', () => {
  let client: SQSClient;
  beforeAll(async () => { client = await createRetryTestClient(); });
  afterAll(() => { client?.destroy(); });

  test('raw receive retains invalid JSON and real FIFO metadata', async () => {
    await withRetryTestQueues(client, async ({ source }) => {
      const sent = await sendRetryBody(client, source, body); const raw = await waitForRawDelivery(client, source);
      expect(raw).toMatchObject({ body, sqsMessageId: sent.MessageId, messageGroupId: 'retry-test-group', approximateReceiveCount: '1' });
      expect(raw.receiptHandle).toBeString(); expect(raw.receiptHandle!.length).toBeGreaterThan(0);
    });
  });

  test('retry changes real visibility and naturally redelivers without deleting', async () => {
    await withRetryTestQueues(client, async ({ source }) => {
      await sendRetryBody(client, source, body);
      // The initial 10-second invisibility must be shortened by the actual 2-second policy command.
      const raw = await waitForRawDelivery(client, { ...source, visibilityTimeout: 10 });
      const observed = observeRetryTransport(client);
      expect(await new SqsWagerRetry(observed.client, source, () => 0.5).apply(raw, transient))
        .toMatchObject({ kind: 'retry-scheduled', visibilityTimeout: 2 });
      expect(observed.trace).toHaveLength(1); expect(observed.trace[0]!.command).toBeInstanceOf(ChangeMessageVisibilityCommand);
      expect(observed.trace[0]!.command.input).toEqual({ QueueUrl: source.queueUrl, ReceiptHandle: raw.receiptHandle, VisibilityTimeout: 2 });
      expect(await new SqsWagerReceiver(client, source).receiveRawOnce()).toBeUndefined();
      const next = await waitForRawDelivery(client, source);
      expect(next).toMatchObject({ body, sqsMessageId: raw.sqsMessageId, approximateReceiveCount: '2' });
      expect(next.receiptHandle).not.toBe(raw.receiptHandle);
    });
  });

  test('five real receives exhaust retry and authorize explicit DLQ without native redrive', async () => {
    await withRetryTestQueues(client, async ({ source, dlq }) => {
      const observed = observeRetryTransport(client); const retry = new SqsWagerRetry(observed.client, source, () => 0.5);
      const adapter = new SqsWagerDlq(observed.client, source, dlq.queueUrl); await adapter.assertExplicitMode();
      await sendRetryBody(client, source, body); let raw = await waitForRawDelivery(client, source);
      for (let count = 1; count <= 5; count++) {
        expect(raw.approximateReceiveCount).toBe(String(count));
        const before = observed.trace.length; const outcome = await retry.apply(raw, transient);
        if (count < 5) {
          expect(outcome).toMatchObject({ kind: 'retry-scheduled', visibilityTimeout: 2 ** count });
          // Only this counter test accelerates visibility through the fixture; natural expiry is tested above.
          raw = await releaseForRedelivery(client, source, raw);
        } else {
          expect(outcome).toMatchObject({ kind: 'deferred', decision: { action: 'send-to-dlq', exhausted: true } });
          expect(observed.trace).toHaveLength(before);
        }
      }
      expect(await adapter.apply(raw, transient)).toMatchObject({ kind: 'forwarded' });
      expect((await receiveDlqMessage(client, dlq)).Body).toBe(body);
      await assertQueueEmptyThrough(client, source, Date.now() + 2200);
    });
  });

  test('confirmed FIFO DLQ publication precedes actual source deletion and preserves identity', async () => {
    await withRetryTestQueues(client, async ({ source, dlq }) => {
      await sendRetryBody(client, source, body); const raw = await waitForRawDelivery(client, source);
      const observed = observeRetryTransport(client);
      const outcome = await new SqsWagerDlq(observed.client, source, dlq.queueUrl).apply(raw, permanent);
      expect(outcome.kind).toBe('forwarded');
      expect(observed.trace.map(entry => entry.command.constructor))
        .toEqual([GetQueueAttributesCommand, GetQueueAttributesCommand, SendMessageCommand, DeleteMessageCommand]);
      expect(observed.trace.slice(0, 2).map(entry => entry.command.input.QueueUrl)).toEqual([source.queueUrl, dlq.queueUrl]);
      const response = observed.trace[2]!.response!;
      expect(response.$metadata.httpStatusCode).toBe(200); expect(response.MessageId).toBeString();
      expect(response.SequenceNumber).toMatch(/^\d+$/); expect(response.MD5OfMessageBody).toBe(createHash('md5').update(body).digest('hex'));
      const transferId = createHash('sha256').update(JSON.stringify(['wager-dlq-v1', source.queueUrl, raw.sqsMessageId])).digest('hex');
      const message = await receiveDlqMessage(client, dlq);
      expect(message).toMatchObject({ Body: body, MessageId: response.MessageId, Attributes: {
        MessageGroupId: raw.messageGroupId, MessageDeduplicationId: transferId, SequenceNumber: response.SequenceNumber,
      }, MessageAttributes: { sourceMessageId: { StringValue: raw.sqsMessageId }, sourceQueueUrl: { StringValue: source.queueUrl }, dlqTransferId: { StringValue: transferId } } });
      await assertQueueEmptyThrough(client, source, Date.now() + 2200);
    });
  });

  test.each(['publish-before', 'publish-after', 'publish-incomplete'] as const)('%s preserves source and distinguishes confirmed broker effects from missing client confirmation', async fault => {
    await withRetryTestQueues(client, async ({ source, dlq }) => {
      await sendRetryBody(client, source, body); const raw = await waitForRawDelivery(client, source);
      const observed = observeRetryTransport(client, fault);
      await expect(new SqsWagerDlq(observed.client, source, dlq.queueUrl).apply(raw, permanent)).rejects.toMatchObject({
        code: fault === 'publish-incomplete' ? 'DLQ_PUBLISH_UNCONFIRMED' : 'DLQ_PUBLISH_FAILED', phase: 'dlq', publication: { kind: 'uncertain' },
      });
      expect(observed.trace.some(entry => entry.command instanceof DeleteMessageCommand)).toBe(false);
      expect((await releaseForRedelivery(client, source, raw)).sqsMessageId).toBe(raw.sqsMessageId);
      if (fault === 'publish-before') await assertQueueEmptyThrough(client, dlq, Date.now());
      else expect((await receiveDlqMessage(client, dlq)).Body).toBe(body);
    });
  });

  test('failed ACK redelivers safely with stable deduplication and the new receipt handle', async () => {
    await withRetryTestQueues(client, async ({ source, dlq }) => {
      await sendRetryBody(client, source, body); const raw = await waitForRawDelivery(client, source);
      const failed = observeRetryTransport(client, 'ack-before');
      await expect(new SqsWagerDlq(failed.client, source, dlq.queueUrl).apply(raw, permanent)).rejects.toMatchObject({ code: 'DLQ_ACK_FAILED', phase: 'ack', publication: { kind: 'confirmed' }, cause: failed.cause });
      const next = await releaseForRedelivery(client, source, raw); const observed = observeRetryTransport(client);
      expect((await new SqsWagerDlq(observed.client, source, dlq.queueUrl).apply(next, permanent)).kind).toBe('forwarded');
      const firstSend = failed.trace.find(entry => entry.command instanceof SendMessageCommand)!.command as SendMessageCommand;
      const secondSend = observed.trace.find(entry => entry.command instanceof SendMessageCommand)!.command as SendMessageCommand;
      expect(secondSend.input).toEqual(firstSend.input);
      expect(observed.trace.at(-1)!.command.input).toEqual({ QueueUrl: source.queueUrl, ReceiptHandle: next.receiptHandle });
      const message = await receiveDlqMessage(client, dlq); expect(message.Body).toBe(body);
      expect((await client.send(new DeleteMessageCommand({ QueueUrl: dlq.queueUrl, ReceiptHandle: message.ReceiptHandle! }))).$metadata.httpStatusCode).toBe(200);
      // After deleting the first copy, a second copy must not be hidden by FIFO group invisibility.
      await assertQueueEmptyThrough(client, dlq, Date.now() + 2200);
      await assertQueueEmptyThrough(client, source, Date.now() + 2200);
    });
  });

  test.each(['ack-after', 'ack-incomplete'] as const)('%s retains confirmed DLQ publication without claiming the original survived', async fault => {
    await withRetryTestQueues(client, async ({ source, dlq }) => {
      await sendRetryBody(client, source, body); const raw = await waitForRawDelivery(client, source);
      const observed = observeRetryTransport(client, fault);
      await expect(new SqsWagerDlq(observed.client, source, dlq.queueUrl).apply(raw, permanent)).rejects.toMatchObject({
        code: fault === 'ack-after' ? 'DLQ_ACK_FAILED' : 'DLQ_ACK_UNCONFIRMED', phase: 'ack', publication: { kind: 'confirmed' },
      });
      expect(observed.trace.at(-1)!.response?.$metadata.httpStatusCode).toBe(200);
      expect((await receiveDlqMessage(client, dlq)).Body).toBe(body);
      await assertQueueEmptyThrough(client, source, Date.now() + 2200);
    });
  });

  test('visibility failure never deletes the original and permits real redelivery', async () => {
    await withRetryTestQueues(client, async ({ source }) => {
      await sendRetryBody(client, source, body); const raw = await waitForRawDelivery(client, source);
      const observed = observeRetryTransport(client, 'visibility-before');
      await expect(new SqsWagerRetry(observed.client, source, () => 0.5).apply(raw, transient)).rejects.toBe(observed.cause);
      expect(observed.trace.map(entry => entry.command.constructor)).toEqual([ChangeMessageVisibilityCommand]);
      expect((await releaseForRedelivery(client, source, raw)).sqsMessageId).toBe(raw.sqsMessageId);
    });
  });

  test.each([3, 5] as const)('native redrive threshold %i blocks explicit preflight and forwarding', async count => {
    await withRetryTestQueues(client, async ({ source, dlq }) => {
      const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: source.queueUrl, AttributeNames: ['RedrivePolicy'] }));
      expect(Number(JSON.parse(attributes.Attributes!.RedrivePolicy!).maxReceiveCount)).toBe(count);
      const observed = observeRetryTransport(client); const adapter = new SqsWagerDlq(observed.client, source, dlq.queueUrl);
      await expect(adapter.assertExplicitMode()).rejects.toMatchObject({ code: 'UNSAFE_DLQ_CONFIGURATION' });
      await sendRetryBody(client, source, body); const raw = await waitForRawDelivery(client, source);
      await expect(adapter.apply(raw, permanent)).rejects.toMatchObject({ code: 'UNSAFE_DLQ_CONFIGURATION', publication: { kind: 'not-attempted' } });
      expect(observed.trace.map(entry => entry.command.constructor)).toEqual([GetQueueAttributesCommand, GetQueueAttributesCommand]);
      // One controlled redelivery stays below either native threshold, avoiding accidental native transfer.
      expect((await releaseForRedelivery(client, source, raw)).approximateReceiveCount).toBe('2');
      await assertQueueEmptyThrough(client, dlq, Date.now());
    }, count);
  });
});
