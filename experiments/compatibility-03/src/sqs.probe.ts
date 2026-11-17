import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand,
  GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient,
  type ReceiveMessageCommandOutput,
} from '@aws-sdk/client-sqs';

const endpoint = 'http://ministack:4566';

@Injectable()
export class SqsProbe {
  async verify(): Promise<void> {
    assert.equal(process.env['GITHUB_ACTIONS'], 'true', 'SQS diagnostics require GitHub Actions');
    assert.equal(process.env['DIAGNOSTIC_CONTAINER'], '1', 'SQS diagnostics require the Compose client');
    assert.equal(process.env['SQS_ENDPOINT'], endpoint, 'Only the disposable MiniStack endpoint is allowed');
    console.log(JSON.stringify({ check: 'sqs_connection', status: 'started' }));

    const healthResponse = await fetch(`${endpoint}/_ministack/health`, { signal: AbortSignal.timeout(3_000) });
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json() as { version?: string; services?: { sqs?: string } };
    assert.equal(health.version, '1.5.39');
    assert.equal(health.services?.sqs, 'available');

    const client = new SQSClient({
      endpoint,
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      // A returned URL must never redirect this probe to another host.
      useQueueUrlAsEndpoint: false,
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000 },
    });
    const queueName = `compatibility-${randomUUID()}.fifo`;
    let queueUrl: string | undefined;
    try {
      const created = await client.send(new CreateQueueCommand({
        QueueName: queueName,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '2' },
      }));
      assert.ok(created.QueueUrl, 'CreateQueue must return a queue URL');
      const returnedUrl = new URL(created.QueueUrl);
      assert.equal(returnedUrl.protocol, 'http:');
      assert.ok(['ministack', 'localhost', '127.0.0.1'].includes(returnedUrl.hostname));
      assert.equal(returnedUrl.port, '4566');
      assert.equal(returnedUrl.pathname, `/000000000000/${queueName}`);
      assert.equal(returnedUrl.search, '');
      assert.equal(returnedUrl.username, '');
      assert.equal(returnedUrl.password, '');
      queueUrl = `${endpoint}${returnedUrl.pathname}`;
      const attributes = await client.send(new GetQueueAttributesCommand({
        QueueUrl: queueUrl, AttributeNames: ['FifoQueue', 'VisibilityTimeout', 'QueueArn'],
      }));
      assert.equal(attributes.Attributes?.['FifoQueue'], 'true');
      assert.equal(attributes.Attributes?.['VisibilityTimeout'], '2');
      assert.equal(attributes.Attributes?.['QueueArn'], `arn:aws:sqs:us-east-1:000000000000:${queueName}`);

      // Transport fixture only: this is not a wager consumer or a domain event.
      const body = JSON.stringify({ probe: 'compatibility-0.4', money: { amount: '9007199254740993.01', currency: 'BRL' } });
      const checksum = createHash('md5').update(body).digest('hex');
      const deduplicationId = randomUUID();
      const sent = await client.send(new SendMessageCommand({
        QueueUrl: queueUrl, MessageBody: body,
        MessageGroupId: 'diagnostic-wallet', MessageDeduplicationId: deduplicationId,
      }));
      assert.ok(sent.MessageId);
      assert.match(sent.SequenceNumber ?? '', /^\d+$/);
      assert.equal(sent.MD5OfMessageBody, checksum);
      const received = await client.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ['All'],
      }));
      assert.equal(received.Messages?.length, 1);
      const message = received.Messages?.[0];
      assert.equal(message?.MessageId, sent.MessageId);
      assert.equal(message?.Body, body);
      assert.equal(message?.MD5OfBody, checksum);
      assert.equal(message?.Attributes?.['MessageGroupId'], 'diagnostic-wallet');
      assert.equal(message?.Attributes?.['MessageDeduplicationId'], deduplicationId);
      assert.equal(message?.Attributes?.['SequenceNumber'], sent.SequenceNumber);
      assert.ok(message?.ReceiptHandle);
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      for (let attempt = 0; attempt < 2; attempt++) {
        const remaining: ReceiveMessageCommandOutput = await client.send(new ReceiveMessageCommand({
          QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 2,
        }));
        assert.equal(remaining.Messages?.length ?? 0, 0, 'Deleted message reappeared');
      }
      console.log(JSON.stringify({ check: 'sqs_fifo_send_receive_delete', status: 'passed' }));
    } finally {
      try {
        if (queueUrl) {
          await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        }
      } finally {
        client.destroy();
      }
    }
  }
}
