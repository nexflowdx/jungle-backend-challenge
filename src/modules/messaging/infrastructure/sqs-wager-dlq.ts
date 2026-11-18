import { createHash } from 'node:crypto';
import {
  DeleteMessageCommand, GetQueueAttributesCommand, SendMessageCommand,
  type DeleteMessageCommandOutput, type GetQueueAttributesCommandOutput, type SendMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import { decideWagerDelivery, type WagerDeliveryDecision, type WagerDeliveryFailure } from '../application/wager-delivery-policy';
import { configuration, type ReceivedRawWagerRequest, type SqsWagerConfiguration } from './sqs-wager-receiver';

export interface SqsDlqClient {
  send(command: SendMessageCommand): Promise<SendMessageCommandOutput>;
  send(command: DeleteMessageCommand): Promise<DeleteMessageCommandOutput>;
  send(command: GetQueueAttributesCommand): Promise<GetQueueAttributesCommandOutput>;
}
export type SqsDlqPublication =
  | { readonly kind: 'not-attempted' }
  | { readonly kind: 'uncertain'; readonly transferId: string }
  | { readonly kind: 'confirmed'; readonly transferId: string; readonly messageId: string; readonly sequenceNumber: string };

export class SqsWagerDlqError extends Error {
  constructor(
    readonly code: 'INVALID_DLQ_METADATA' | 'UNSAFE_DLQ_CONFIGURATION' | 'DLQ_CONFIGURATION_CHECK_FAILED'
      | 'DLQ_PUBLISH_FAILED' | 'DLQ_PUBLISH_UNCONFIRMED' | 'DLQ_ACK_FAILED' | 'DLQ_ACK_UNCONFIRMED',
    readonly phase: 'validation' | 'configuration' | 'dlq' | 'ack',
    readonly publication: SqsDlqPublication,
    readonly originalFailure: WagerDeliveryFailure | undefined,
    detail: string,
    cause?: unknown,
  ) {
    super(`${code}: ${detail}`, { cause });
    this.name = 'SqsWagerDlqError';
  }
}

export type SqsWagerDlqResult =
  | { readonly kind: 'deferred'; readonly decision: Exclude<WagerDeliveryDecision, { action: 'send-to-dlq' }> }
  | { readonly kind: 'forwarded'; readonly decision: Extract<WagerDeliveryDecision, { action: 'send-to-dlq' }>;
      readonly publication: Extract<SqsDlqPublication, { kind: 'confirmed' }> };

function printable(value: unknown, maximum = Infinity): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[^\x21-\x7e]/.test(value);
}

/** Explicit transport adapter. No financial processing, polling, FAILED persistence or native redrive. */
export class SqsWagerDlq {
  private readonly queueUrl: string;
  private readonly dlqUrl: string;
  constructor(private readonly client: SqsDlqClient, config: SqsWagerConfiguration, dlqUrl: string) {
    this.queueUrl = new URL(configuration(config).queueUrl).href;
    this.dlqUrl = new URL(configuration({ ...config, queueUrl: dlqUrl }).queueUrl).href;
    if (this.queueUrl === this.dlqUrl) {
      throw new SqsWagerDlqError('UNSAFE_DLQ_CONFIGURATION', 'configuration', { kind: 'not-attempted' }, undefined, 'Source and DLQ must be distinct');
    }
  }

  /** Must also run before any future consumer starts receiving. Rechecked before every publication. */
  async assertExplicitMode(originalFailure?: WagerDeliveryFailure): Promise<void> {
    let response: GetQueueAttributesCommandOutput;
    try {
      response = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['FifoQueue', 'RedrivePolicy'] }));
    } catch (cause) {
      throw new SqsWagerDlqError('DLQ_CONFIGURATION_CHECK_FAILED', 'configuration', { kind: 'not-attempted' }, originalFailure, 'Cannot verify source queue attributes', cause);
    }
    if (response?.$metadata?.httpStatusCode !== 200 || response.Attributes?.FifoQueue !== 'true'
      || Object.hasOwn(response.Attributes, 'RedrivePolicy')) {
      throw new SqsWagerDlqError('UNSAFE_DLQ_CONFIGURATION', 'configuration', { kind: 'not-attempted' }, originalFailure, 'Confirmed FIFO source without native RedrivePolicy is required');
    }
    try {
      response = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: this.dlqUrl, AttributeNames: ['FifoQueue'] }));
    } catch (cause) {
      throw new SqsWagerDlqError('DLQ_CONFIGURATION_CHECK_FAILED', 'configuration', { kind: 'not-attempted' }, originalFailure, 'Cannot verify destination DLQ attributes', cause);
    }
    if (response?.$metadata?.httpStatusCode !== 200 || response.Attributes?.FifoQueue !== 'true') {
      throw new SqsWagerDlqError('UNSAFE_DLQ_CONFIGURATION', 'configuration', { kind: 'not-attempted' }, originalFailure, 'Confirmed HTTP 200 and FIFO destination DLQ are required');
    }
  }

  async apply(delivery: ReceivedRawWagerRequest, failure: WagerDeliveryFailure): Promise<SqsWagerDlqResult> {
    const invalid = (field: string): never => {
      throw new SqsWagerDlqError('INVALID_DLQ_METADATA', 'validation', { kind: 'not-attempted' }, failure, `Invalid or missing ${field}`);
    };
    const { body, sqsMessageId, receiptHandle, messageGroupId, approximateReceiveCount } = delivery;
    if (typeof body !== 'string' || body.length === 0) return invalid('body');
    if (!printable(sqsMessageId, 100)) return invalid('sqsMessageId');
    if (!printable(receiptHandle)) return invalid('receiptHandle');
    if (!printable(messageGroupId, 128)) return invalid('messageGroupId');
    if (typeof approximateReceiveCount !== 'string' || approximateReceiveCount !== approximateReceiveCount.trim()
      || !/^[1-9]\d*$/.test(approximateReceiveCount) || !Number.isSafeInteger(Number(approximateReceiveCount))) return invalid('approximateReceiveCount');

    // Evidence is supplied by the caller; a familiar exception never proves rollback.
    const decision = decideWagerDelivery({ kind: 'failure', failure }, Number(approximateReceiveCount), 0.5);
    if (decision.action !== 'send-to-dlq') return Object.freeze({ kind: 'deferred', decision });
    await this.assertExplicitMode(failure);

    const transferId = createHash('sha256').update(JSON.stringify(['wager-dlq-v1', this.queueUrl, sqsMessageId])).digest('hex');
    const uncertain: SqsDlqPublication = Object.freeze({ kind: 'uncertain', transferId });
    let response: SendMessageCommandOutput;
    try {
      response = await this.client.send(new SendMessageCommand({ QueueUrl: this.dlqUrl, MessageBody: body,
        MessageGroupId: messageGroupId, MessageDeduplicationId: transferId, MessageAttributes: {
          sourceQueueUrl: { DataType: 'String', StringValue: this.queueUrl },
          sourceMessageId: { DataType: 'String', StringValue: sqsMessageId },
          dlqTransferId: { DataType: 'String', StringValue: transferId },
        } }));
    } catch (cause) {
      throw new SqsWagerDlqError('DLQ_PUBLISH_FAILED', 'dlq', uncertain, failure, 'SendMessage failed; publication may have occurred; source must be retained', cause);
    }
    const sequence = response?.SequenceNumber;
    // FIFO decimal sequences may contain leading zeroes (MiniStack 1.5.39 uses zfill(20)).
    if (response?.$metadata?.httpStatusCode !== 200 || !printable(response.MessageId, 100)
      || typeof sequence !== 'string' || !/^\d{1,39}$/.test(sequence) || sequence !== sequence.trim()
      || BigInt(sequence) > (1n << 128n) - 1n
      || typeof response.MD5OfMessageBody !== 'string'
      || response.MD5OfMessageBody.toLowerCase() !== createHash('md5').update(body, 'utf8').digest('hex')) {
      throw new SqsWagerDlqError('DLQ_PUBLISH_UNCONFIRMED', 'dlq', uncertain, failure, 'Missing or invalid FIFO publication confirmation; source must be retained');
    }
    const publication = Object.freeze({ kind: 'confirmed' as const, transferId, messageId: response.MessageId, sequenceNumber: sequence });
    let ack: DeleteMessageCommandOutput;
    try {
      ack = await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }));
    } catch (cause) {
      throw new SqsWagerDlqError('DLQ_ACK_FAILED', 'ack', publication, failure, 'DLQ publication confirmed; source deletion failed or is uncertain', cause);
    }
    if (ack?.$metadata?.httpStatusCode !== 200) {
      throw new SqsWagerDlqError('DLQ_ACK_UNCONFIRMED', 'ack', publication, failure, 'DLQ publication confirmed; source deletion is unconfirmed');
    }
    return Object.freeze({ kind: 'forwarded', decision, publication });
  }
}
