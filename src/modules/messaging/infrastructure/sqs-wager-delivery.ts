import { DeleteMessageCommand, type DeleteMessageCommandOutput } from '@aws-sdk/client-sqs';
import type { SqsWagerCommandHandler } from '../application/sqs-wager-command-handler';
import { InvalidWagerMessageError } from '../application/wager-requested';
import { configuration, type ReceivedWagerRequest, type SqsWagerConfiguration } from './sqs-wager-receiver';

export interface SqsAckClient {
  send(command: DeleteMessageCommand): Promise<DeleteMessageCommandOutput>;
}
/** One explicitly supplied delivery; no polling, retry, DLQ or shutdown policy. */
export class SqsWagerDelivery {
  private readonly queueUrl: string;
  constructor(private readonly handler: Pick<SqsWagerCommandHandler, 'execute'>, private readonly client: SqsAckClient, config: SqsWagerConfiguration) {
    this.queueUrl = configuration(config).queueUrl;
  }
  async execute(delivery: ReceivedWagerRequest) {
    if (typeof delivery.receiptHandle !== 'string' || !delivery.receiptHandle.trim()
      || typeof delivery.sqsMessageId !== 'string' || !delivery.sqsMessageId.trim()) throw new InvalidWagerMessageError();
    // The real handler resolves only after the shared financial/inbox transaction committed.
    const result = await this.handler.execute(delivery.envelope);
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: delivery.receiptHandle }));
    return result;
  }
}
