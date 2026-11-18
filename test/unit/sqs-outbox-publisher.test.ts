import { createHash } from 'node:crypto';
import { expect, mock, test } from 'bun:test';
import {
  SendMessageCommand,
  type SendMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import type { ReservedOutboxEvent } from '../../src/modules/messaging/application/outbox-reservation';
import { SqsOutboxPublisher } from '../../src/modules/messaging/infrastructure/sqs-outbox-publisher';

const queueUrl = 'http://localhost:4566/000000000000/wager-events.fifo';

const event: ReservedOutboxEvent = {
  id: 'event-123',
  aggregateId: 'wallet-456',
  eventType: 'WagerAccepted',
  eventVersion: 1,
  payload: { amount: 100, currency: 'BRL' },
  occurredAt: new Date('2026-11-18T10:00:00.000Z'),
  attempts: 1,
  nextAttemptAt: null,
  publishedAt: null,
  leaseToken: 'lease-789',
  leaseUntil: new Date('2026-11-18T10:00:30.000Z'),
};

function fixture(options: {
  response?: SendMessageCommandOutput;
  failure?: Error;
} = {}) {
  const send = mock(async (command: SendMessageCommand): Promise<SendMessageCommandOutput> => {
    if (options.failure) throw options.failure;

    const body = command.input.MessageBody!;

    return options.response ?? {
      $metadata: { httpStatusCode: 200 },
      MessageId: 'sqs-message-123',
      SequenceNumber: '00000000000000000001',
      MD5OfMessageBody: createHash('md5').update(body, 'utf8').digest('hex'),
    };
  });

  return {
    send,
    publisher: new SqsOutboxPublisher({ send }, queueUrl),
  };
}

test('publishes the stable event envelope to the dedicated FIFO queue', async () => {
  const f = fixture();

  const result = await f.publisher.publish(event);

  expect(result).toEqual({
    eventId: 'event-123',
    messageId: 'sqs-message-123',
    sequenceNumber: '00000000000000000001',
  });

  expect(f.send).toHaveBeenCalledTimes(1);

  const command = f.send.mock.calls[0]![0];

  expect(command).toBeInstanceOf(SendMessageCommand);
  expect(command.input.QueueUrl).toBe(queueUrl);
  expect(command.input.MessageGroupId).toBe(event.aggregateId);
  expect(command.input.MessageDeduplicationId).toBe(event.id);

  expect(JSON.parse(command.input.MessageBody!)).toEqual({
    eventId: event.id,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payload,
  });
});

test('preserves event identity across publication attempts', async () => {
  const f = fixture();

  await f.publisher.publish(event);
  await f.publisher.publish({
    ...event,
    attempts: 2,
    leaseToken: 'another-lease',
    leaseUntil: new Date('2026-11-18T10:01:00.000Z'),
  });

  expect(f.send).toHaveBeenCalledTimes(2);

  const first = f.send.mock.calls[0]![0].input;
  const second = f.send.mock.calls[1]![0].input;

  expect(first.MessageDeduplicationId).toBe(event.id);
  expect(second.MessageDeduplicationId).toBe(event.id);
  expect(first.MessageBody).toBe(second.MessageBody);
});

test('network failure does not produce publication confirmation', async () => {
  const f = fixture({ failure: new Error('SQS unavailable') });

  await expect(f.publisher.publish(event)).rejects.toThrow('SQS unavailable');
  expect(f.send).toHaveBeenCalledTimes(1);
});

test.each([
  ['HTTP failure', { $metadata: { httpStatusCode: 500 } }],
  ['missing message ID', { $metadata: { httpStatusCode: 200 } }],
  ['invalid sequence', { $metadata: { httpStatusCode: 200 }, MessageId: 'message', SequenceNumber: 'invalid' }],
  ['invalid MD5', {
    $metadata: { httpStatusCode: 200 },
    MessageId: 'message',
    SequenceNumber: '1',
    MD5OfMessageBody: 'invalid',
  }],
])('rejects unconfirmed SQS publication: %s', async (_scenario, response) => {
  const f = fixture({ response });

  await expect(f.publisher.publish(event)).rejects.toThrow(
    'Outbox SQS publication unconfirmed',
  );
});

test('rejects an incorrect destination queue', () => {
  const send = mock(async (_command: SendMessageCommand): Promise<SendMessageCommandOutput> => ({
    $metadata: { httpStatusCode: 200 },
  }));

  expect(() => new SqsOutboxPublisher(
    { send },
    'http://localhost:4566/000000000000/wager-transactions.fifo',
  )).toThrow('Invalid outbox SQS queue URL');

  expect(send).not.toHaveBeenCalled();
});
