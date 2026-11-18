import { ReceiveMessageCommand, SQSClient, type ReceiveMessageCommandOutput, type SQSClientConfig } from '@aws-sdk/client-sqs';
import { InvalidWagerMessageError, parseWagerTransactionRequested, type WagerTransactionRequested } from '../application/wager-requested';

export interface SqsReceiveClient {
  send(command: ReceiveMessageCommand): Promise<ReceiveMessageCommandOutput>;
}
export interface SqsWagerConfiguration {
  readonly endpoint: string;
  readonly region: string;
  readonly queueUrl: string;
  readonly visibilityTimeout: number;
  readonly waitTimeSeconds: number;
}
export interface ReceivedWagerRequest {
  readonly sqsMessageId: string;
  readonly receiptHandle: string;
  readonly messageGroupId: string;
  readonly envelope: WagerTransactionRequested;
}
export function configuration(value: SqsWagerConfiguration): Readonly<SqsWagerConfiguration> {
  const invalid = (): never => { throw new Error('Invalid SQS wagering configuration'); };
  const url = (input: string) => {
    if (typeof input !== 'string' || input !== input.trim()) return invalid();
    try {
      const result = new URL(input);
      if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password || result.search || result.hash) return invalid();
      return result;
    } catch { return invalid(); }
  };
  url(value.endpoint); const queue = url(value.queueUrl);
  if (!queue.pathname.endsWith('.fifo') || typeof value.region !== 'string' || !/^[a-z0-9-]+$/.test(value.region)
    || !Number.isInteger(value.visibilityTimeout) || value.visibilityTimeout < 0 || value.visibilityTimeout > 43200
    || !Number.isInteger(value.waitTimeSeconds) || value.waitTimeSeconds < 0 || value.waitTimeSeconds > 20) return invalid();
  return Object.freeze({ endpoint: value.endpoint, region: value.region, queueUrl: value.queueUrl,
    visibilityTimeout: value.visibilityTimeout, waitTimeSeconds: value.waitTimeSeconds });
}
/** Creating a client performs no receive. Credentials are explicit or supplied by the AWS credential chain. */
export function createSqsWagerClient(config: SqsWagerConfiguration, credentials?: SQSClientConfig['credentials']): SQSClient {
  const checked = configuration(config);
  return new SQSClient({ endpoint: checked.endpoint, region: checked.region, maxAttempts: 1, useQueueUrlAsEndpoint: false,
    ...(credentials === undefined ? {} : { credentials }) });
}

/** One explicit receive, no loop, deletion, dispatch, visibility extension or retry. */
export class SqsWagerReceiver {
  private readonly config: Readonly<SqsWagerConfiguration>;
  constructor(private readonly client: SqsReceiveClient, config: SqsWagerConfiguration) { this.config = configuration(config); }
  async receiveOnce(): Promise<ReceivedWagerRequest | undefined> {
    const response = await this.client.send(new ReceiveMessageCommand({ QueueUrl: this.config.queueUrl,
      MaxNumberOfMessages: 1, VisibilityTimeout: this.config.visibilityTimeout, WaitTimeSeconds: this.config.waitTimeSeconds,
      MessageSystemAttributeNames: ['MessageGroupId'],
    }));
    const messages = response.Messages ?? [];
    if (messages.length === 0) return undefined;
    const message = messages[0]!;
    const group = message.Attributes?.MessageGroupId;
    if (messages.length !== 1 || typeof message.Body !== 'string'
      || typeof message.MessageId !== 'string' || !message.MessageId.trim()
      || typeof message.ReceiptHandle !== 'string' || !message.ReceiptHandle.trim()
      || typeof group !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(group)) throw new InvalidWagerMessageError();
    let body: unknown;
    try { body = JSON.parse(message.Body) as unknown; } catch { throw new InvalidWagerMessageError(); }
    return Object.freeze({ sqsMessageId: message.MessageId, receiptHandle: message.ReceiptHandle,
      messageGroupId: group, envelope: parseWagerTransactionRequested(body) });
  }
}
