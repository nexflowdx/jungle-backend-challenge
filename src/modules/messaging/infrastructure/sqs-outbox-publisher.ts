import { createHash } from 'node:crypto';
import {
  SendMessageCommand,
  type SendMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import type { ReservedOutboxEvent } from '../application/outbox-reservation';
import { JsonLogger, jsonLogger } from '../../operations/json-logger';
import { runWithLogContext, type LogIdentifiers } from '../../operations/log-context';

export interface SqsOutboxSendClient {
  send(
    command: SendMessageCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<SendMessageCommandOutput>;
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
    private readonly logger: JsonLogger = jsonLogger,
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

  publish(event: ReservedOutboxEvent, abortSignal?: AbortSignal): Promise<OutboxPublication> {
    let context: LogIdentifiers = {};
    try {
      const data = event.payload.data as Record<string, unknown> | undefined;
      context = {
        walletId: event.aggregateId,
        ...(typeof event.payload.correlationId === 'string' ? { correlationId: event.payload.correlationId } : {}),
        ...(typeof data?.transactionId === 'string' ? { transactionId: data.transactionId } : {}),
        ...(typeof data?.providerId === 'string' ? { providerId: data.providerId } : {}),
      };
    } catch { /* Observability must not add new publication validation failures. */ }
    return runWithLogContext(context, async () => {
      try {
        const result = await this.publishEvent(event, abortSignal);
        this.logger.emit('info', 'outbox.publication_confirmed');
        return result;
      } catch (error) {
        this.logger.emit('error', 'outbox.publication_failed');
        throw error;
      }
    });
  }

  private async publishEvent(
    event: ReservedOutboxEvent,
    abortSignal?: AbortSignal,
  ): Promise<OutboxPublication> {
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
    }), abortSignal ? { abortSignal } : {});

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
