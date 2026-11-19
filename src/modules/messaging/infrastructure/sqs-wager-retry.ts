import { ChangeMessageVisibilityCommand, type ChangeMessageVisibilityCommandOutput } from '@aws-sdk/client-sqs';
import { decideWagerDelivery, type WagerDeliveryDecision, type WagerDeliveryFailure } from '../application/wager-delivery-policy';
import { configuration, type ReceivedRawWagerRequest, type SqsWagerConfiguration } from './sqs-wager-receiver';
import { operationalMetrics } from '../../operations/operational-metrics';

export interface SqsVisibilityClient {
  send(command: ChangeMessageVisibilityCommand): Promise<ChangeMessageVisibilityCommandOutput>;
}
export type SqsWagerRetryResult =
  | { readonly kind: 'retry-scheduled'; readonly decision: Extract<WagerDeliveryDecision, { action: 'retry' }>; readonly visibilityTimeout: number }
  | { readonly kind: 'deferred'; readonly decision: Exclude<WagerDeliveryDecision, { action: 'retry' }> };

/** Explicit visibility operation only: no dispatch, ACK, DLQ publication or financial inference.
 * The caller must supply evidence independently of the caught exception.
 */
export class SqsWagerRetry {
  private readonly queueUrl: string;
  constructor(private readonly client: SqsVisibilityClient, config: SqsWagerConfiguration, private readonly jitterSample: () => number = Math.random) {
    this.queueUrl = configuration(config).queueUrl;
  }

  async apply(delivery: ReceivedRawWagerRequest, failure: WagerDeliveryFailure): Promise<SqsWagerRetryResult> {
    const { receiptHandle, approximateReceiveCount } = delivery;
    if (typeof receiptHandle !== 'string' || receiptHandle.length === 0 || /[^\x21-\x7e]/.test(receiptHandle)) {
      throw new RangeError('Retry requires a non-empty SQS receipt handle without whitespace');
    }
    if (typeof approximateReceiveCount !== 'string' || approximateReceiveCount !== approximateReceiveCount.trim() || !/^[1-9]\d*$/.test(approximateReceiveCount)
      || !Number.isSafeInteger(Number(approximateReceiveCount))) {
      throw new RangeError('Retry requires a positive safe integer SQS receive count');
    }
    const decision = decideWagerDelivery({ kind: 'failure', failure }, Number(approximateReceiveCount), this.jitterSample());
    // send-to-dlq is eligibility only; it must never fall through into deletion or success.
    if (decision.action !== 'retry') return Object.freeze({ kind: 'deferred', decision });
    const visibilityTimeout = Math.max(1, Math.min(60, Math.ceil(decision.delaySeconds)));
    const response = await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: visibilityTimeout }));
    if (response?.$metadata?.httpStatusCode === 200) operationalMetrics.increment('sqs_visibility_retries_confirmed');
    return Object.freeze({ kind: 'retry-scheduled', decision, visibilityTimeout });
  }
}
