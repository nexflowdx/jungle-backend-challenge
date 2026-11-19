import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import type { ReservedOutboxEvent } from '../../src/modules/messaging/application/outbox-reservation';
import { SqsOutboxPublisher } from '../../src/modules/messaging/infrastructure/sqs-outbox-publisher';
import { JsonLogger } from '../../src/modules/operations/json-logger';
import { assertSqsTestEnvironment } from '../helpers/sqs-test-environment';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
const endpoint = 'http://ministack:4566';
const queueName = 'wager-events.fifo';
const queueUrl = `${endpoint}/000000000000/${queueName}`;

describe.skipIf(!enabled)('SQS outbox publication (real MiniStack)', () => {
  test('publishes and receives the stable event envelope', async () => {
    assertSqsTestEnvironment(process.env);

    const client = new SQSClient({
      endpoint,
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
      maxAttempts: 1,
      useQueueUrlAsEndpoint: false,
      requestHandler: {
        connectionTimeout: 2000,
        requestTimeout: 5000,
      },
    });

    let createdByTest = false;

    try {
      let alreadyExists = false;

      try {
        await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
        alreadyExists = true;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'QueueDoesNotExist') {
          throw error;
        }
      }

      expect(alreadyExists).toBe(false);
      if (alreadyExists) throw new Error('Outbox test queue already exists');

      const created = await client.send(new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
        },
      }));

      createdByTest = true;
      expect(new URL(created.QueueUrl!).pathname).toBe(`/000000000000/${queueName}`);

      const event: ReservedOutboxEvent = {
        id: randomUUID(),
        aggregateId: randomUUID(),
        eventType: 'WagerAccepted',
        eventVersion: 1,
        payload: { correlationId: 'persisted-correlation', causationId: 'CAUSATION_SECRET', data: { transactionId: randomUUID(), providerId: 'provider' } },
        occurredAt: new Date('2026-11-18T10:00:00.000Z'),
        attempts: 1,
        nextAttemptAt: null,
        publishedAt: null,
        leaseToken: randomUUID(),
        leaseUntil: new Date('2026-11-18T10:00:30.000Z'),
      };

      const lines: string[] = [];
      const publisher = new SqsOutboxPublisher(client, queueUrl, new JsonLogger(line => lines.push(line)));
      const published = await publisher.publish(event);

      expect(published.eventId).toBe(event.id);
      expect(published.messageId.length).toBeGreaterThan(0);
      expect(published.sequenceNumber).toMatch(/^\d+$/);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(JSON.parse(lines[0]!)).toMatchObject({ correlationId: 'persisted-correlation', walletId: event.aggregateId, event: 'outbox.publication_confirmed' });
      expect(lines[0]!).not.toContain('SECRET'); expect(lines[0]!).not.toContain('messageId');

      const received = await client.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ['All'],
      }));

      expect(received.Messages).toHaveLength(1);

      const message = received.Messages![0]!;
      expect(message.MessageId).toBe(published.messageId);
      expect(message.Attributes?.MessageGroupId).toBe(event.aggregateId);
      expect(message.Attributes?.MessageDeduplicationId).toBe(event.id);

      expect(JSON.parse(message.Body!)).toEqual({
        eventId: event.id,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        eventVersion: event.eventVersion,
        occurredAt: event.occurredAt.toISOString(),
        payload: event.payload,
      });

      // Simulates a successful send followed by a lost database confirmation.
      // A recovered publisher sends the same durable event identity again.
      const repeated = await new SqsOutboxPublisher(client, queueUrl, new JsonLogger(() => Promise.reject(new Error('LOG_SECRET')))).publish({
        ...event,
        attempts: 2,
        leaseToken: randomUUID(),
      });

      expect(repeated.eventId).toBe(event.id);

      const duplicate = await client.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }));

      // FIFO suppresses the immediate duplicate; persistent consumer
      // deduplication is still required outside the FIFO deduplication window.
      expect(duplicate.Messages ?? []).toHaveLength(0);
    } finally {
      try {
        if (createdByTest) {
          await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        }
      } finally {
        client.destroy();
      }
    }
  }, 10000);
});
