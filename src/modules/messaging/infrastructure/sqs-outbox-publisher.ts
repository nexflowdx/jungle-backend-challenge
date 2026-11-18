import { createHash } from 'node:crypto';
import {
  SendMessageCommand,
  type SendMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import type { ReservedOutboxEvent } from '../application/outbox-reservation';

export interface SqsOutboxSendClient {
  send(command: SendMessageCommand): Promise<SendMessageCommandOutput>;
}

export interface OutboxPublication {
  readonly eventId: string;
  readonly messageId: string;
  readonly sequenceNumber: string;
}

export class SqsOutboxPublisher {
  constructor(
    private readonly client: SqsOutboxSendClient,
    private readonly queueUrl: string,
  ) {
    let url: URL;

    try {
      url = new URL(queueUrl);
    } catch {
      throw new Error('Invalid outbox SQS queue URL');
    }

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('/wager-events.fifo')
    ) {
      throw new Error('Invalid outbox SQS queue URL');
    }
  }

  async publish(event: ReservedOutboxEvent): Promise<OutboxPublication> {
    if (
      !event.id ||
      !event.aggregateId ||
      !event.eventType ||
      !Number.isSafeInteger(event.eventVersion) ||
      !(event.occurredAt instanceof Date) ||
      !Number.isFinite(event.occurredAt.getTime())
    ) {
      throw new Error('Invalid outbox event');
    }

    const body = JSON.stringify({
      eventId: event.id,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      occurredAt: event.occurredAt.toISOString(),
      payload: event.payload,
    });

    if (Buffer.byteLength(body, 'utf8') > 1048576) {
      throw new Error('Outbox event exceeds SQS message size');
    }

    const response = await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: body,
      MessageGroupId: event.aggregateId,
      MessageDeduplicationId: event.id,
    }));

    const sequence = response.SequenceNumber;

    if (
      response.$metadata?.httpStatusCode !== 200 ||
      typeof response.MessageId !== 'string' ||
      !/^[\x21-\x7e]{1,100}$/.test(response.MessageId) ||
      typeof sequence !== 'string' ||
      !/^\d{1,39}$/.test(sequence) ||
      BigInt(sequence) > (1n << 128n) - 1n ||
      typeof response.MD5OfMessageBody !== 'string' ||
      response.MD5OfMessageBody.toLowerCase() !==
        createHash('md5').update(body, 'utf8').digest('hex')
    ) {
      throw new Error('Outbox SQS publication unconfirmed');
    }

    return Object.freeze({
      eventId: event.id,
      messageId: response.MessageId,
      sequenceNumber: sequence,
    });
  }
}
