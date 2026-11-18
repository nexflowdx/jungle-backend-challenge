import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import {
  ChangeMessageVisibilityCommand, CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand,
  GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient,
  type ChangeMessageVisibilityCommandOutput, type DeleteMessageCommandOutput,
  type GetQueueAttributesCommandOutput, type Message, type SendMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import { expect } from 'bun:test';
import { SqsWagerReceiver, type ReceivedRawWagerRequest, type SqsWagerConfiguration } from '../../src/modules/messaging/infrastructure/sqs-wager-receiver';
import { assertSqsTestEnvironment } from './sqs-test-environment';

const endpoint = 'http://ministack:4566';
export async function createRetryTestClient(): Promise<SQSClient> {
  assertSqsTestEnvironment(process.env);
  const health = await fetch(`${endpoint}/_ministack/health`, { signal: AbortSignal.timeout(3000) });
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ version: '1.5.39', services: { sqs: 'available' } });
  return new SQSClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1, useQueueUrlAsEndpoint: false, requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 } });
}

export interface RetryTestQueues {
  readonly source: SqsWagerConfiguration;
  readonly dlq: SqsWagerConfiguration;
}
export async function withRetryTestQueues(client: SQSClient, run: (queues: RetryTestQueues) => Promise<void>, redriveCount?: 3 | 5): Promise<void> {
  const created: string[] = [];
  let originalError: unknown;
  let failed = false;
  const create = async (name: string, attributes: Record<string, string> = {}): Promise<SqsWagerConfiguration> => {
    const queueUrl = `${endpoint}/000000000000/${name}`;
    const response = await client.send(new CreateQueueCommand({ QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '2', ...attributes } }));
    created.push(queueUrl); // Register before assertions so a malformed successful response is cleaned up too.
    expect(response.$metadata.httpStatusCode).toBe(200);
    const returned = new URL(response.QueueUrl!);
    expect(['ministack', 'localhost', '127.0.0.1']).toContain(returned.hostname);
    expect(returned.port).toBe('4566'); expect(returned.pathname).toBe(`/000000000000/${name}`);
    return { endpoint, region: 'us-east-1', queueUrl, visibilityTimeout: 2, waitTimeSeconds: 0 };
  };
  try {
    const id = randomUUID(); const dlq = await create(`retry-dlq-${id}.fifo`);
    const attributes: Record<string, string> = {};
    if (redriveCount !== undefined) {
      const response = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq.queueUrl, AttributeNames: ['QueueArn'] }));
      expect(response.Attributes?.QueueArn).toBe(`arn:aws:sqs:us-east-1:000000000000:retry-dlq-${id}.fifo`);
      attributes.RedrivePolicy = JSON.stringify({ deadLetterTargetArn: response.Attributes!.QueueArn, maxReceiveCount: String(redriveCount) });
    }
    const source = await create(`retry-source-${id}.fifo`, attributes);
    await run({ source, dlq });
  } catch (error) {
    failed = true;
    originalError = error;
    throw error;
  } finally {
    const errors: unknown[] = [];
    // Reverse creation order: source first, then DLQ. Each deletion is awaited independently.
    for (const queueUrl of created.reverse()) {
      try { await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl })); }
      catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      throw new AggregateError(failed ? [originalError, ...errors] : errors,
        failed ? 'Test and disposable SQS queue cleanup failed' : 'Failed to clean up disposable SQS retry queues',
        failed ? { cause: originalError } : undefined);
    }
  }
}

export async function sendRetryBody(client: SQSClient, config: SqsWagerConfiguration, body: string): Promise<SendMessageCommandOutput> {
  const response = await client.send(new SendMessageCommand({ QueueUrl: config.queueUrl, MessageBody: body,
    MessageGroupId: 'retry-test-group', MessageDeduplicationId: randomUUID() }));
  expect(response.$metadata.httpStatusCode).toBe(200); expect(response.MessageId).toBeString();
  return response;
}

export async function waitForRawDelivery(client: SQSClient, config: SqsWagerConfiguration): Promise<ReceivedRawWagerRequest> {
  const receiver = new SqsWagerReceiver(client, config); const deadline = Date.now() + 5000;
  do {
    const delivery = await receiver.receiveRawOnce();
    if (delivery) return delivery;
    await pause(40); // Fixture observation pacing only; application backoff is ChangeMessageVisibility.
  } while (Date.now() < deadline);
  throw new Error('MiniStack 1.5.39 did not expose the expected delivery within 5 seconds');
}

export async function releaseForRedelivery(client: SQSClient, config: SqsWagerConfiguration, delivery: ReceivedRawWagerRequest): Promise<ReceivedRawWagerRequest> {
  expect((await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: config.queueUrl, ReceiptHandle: delivery.receiptHandle!, VisibilityTimeout: 0 }))).$metadata.httpStatusCode).toBe(200);
  const next = await waitForRawDelivery(client, config);
  expect(next.sqsMessageId).toBe(delivery.sqsMessageId); expect(next.body).toBe(delivery.body);
  expect(next.receiptHandle).not.toBe(delivery.receiptHandle);
  expect(next.approximateReceiveCount).toBe(String(Number(delivery.approximateReceiveCount) + 1));
  return next;
}

export async function receiveDlqMessage(client: SQSClient, config: SqsWagerConfiguration): Promise<Message> {
  const deadline = Date.now() + 5000;
  do {
    const response = await client.send(new ReceiveMessageCommand({ QueueUrl: config.queueUrl, MaxNumberOfMessages: 1,
      VisibilityTimeout: 10, WaitTimeSeconds: 0, MessageSystemAttributeNames: ['All'], MessageAttributeNames: ['All'] }));
    if (response.Messages?.[0]) return response.Messages[0];
    await pause(40);
  } while (Date.now() < deadline);
  throw new Error('MiniStack 1.5.39 did not expose the expected DLQ publication within 5 seconds');
}

/** Keep observing beyond the previous visibility deadline: an empty in-flight receive alone proves nothing. */
export async function assertQueueEmptyThrough(client: SQSClient, config: SqsWagerConfiguration, deadline: number): Promise<void> {
  do {
    const response = await client.send(new ReceiveMessageCommand({ QueueUrl: config.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 0 }));
    expect(response.Messages ?? []).toEqual([]);
    if (Date.now() >= deadline) return;
    await pause(40);
  } while (true);
}

export type RetryTestCommand = GetQueueAttributesCommand | SendMessageCommand | DeleteMessageCommand | ChangeMessageVisibilityCommand;
type RetryTestOutput = GetQueueAttributesCommandOutput & SendMessageCommandOutput & DeleteMessageCommandOutput & ChangeMessageVisibilityCommandOutput;
export type TransportFault = 'publish-before' | 'publish-after' | 'publish-incomplete' | 'ack-before' | 'ack-after' | 'ack-incomplete' | 'visibility-before';
export interface RetryTestTrace {
  readonly command: RetryTestCommand;
  response?: RetryTestOutput;
}
/** Explicit fault injection around real SDK operations; no emulator feature is replaced or fabricated. */
export function observeRetryTransport(client: SQSClient, fault?: TransportFault) {
  const trace: RetryTestTrace[] = []; const cause = new Error(`Injected transport failure: ${fault}`);
  const send = async (command: RetryTestCommand): Promise<RetryTestOutput> => {
    const entry: RetryTestTrace = { command }; trace.push(entry);
    const publish = command instanceof SendMessageCommand; const ack = command instanceof DeleteMessageCommand;
    if ((publish && fault === 'publish-before') || (ack && fault === 'ack-before')
      || (command instanceof ChangeMessageVisibilityCommand && fault === 'visibility-before')) throw cause;
    const response = command instanceof GetQueueAttributesCommand ? await client.send(command)
      : command instanceof SendMessageCommand ? await client.send(command)
        : command instanceof DeleteMessageCommand ? await client.send(command)
          : await client.send(command);
    entry.response = response;
    if ((publish && fault === 'publish-after') || (ack && fault === 'ack-after')) throw cause;
    if (publish && fault === 'publish-incomplete') return { ...response, SequenceNumber: undefined };
    if (ack && fault === 'ack-incomplete') return { ...response, $metadata: {} };
    return response;
  };
  return { client: { send }, trace, cause };
}
