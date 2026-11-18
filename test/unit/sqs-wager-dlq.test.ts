import { createHash } from 'node:crypto';
import { expect, mock, test } from 'bun:test';
import {
  DeleteMessageCommand, GetQueueAttributesCommand, SendMessageCommand,
  type DeleteMessageCommandOutput, type GetQueueAttributesCommandOutput, type SendMessageCommandOutput,
} from '@aws-sdk/client-sqs';
import { SqsWagerDlq, SqsWagerDlqError } from '../../src/modules/messaging/infrastructure/sqs-wager-dlq';
import type { ReceivedRawWagerRequest, SqsWagerConfiguration } from '../../src/modules/messaging/infrastructure/sqs-wager-receiver';
import type { WagerDeliveryFailure } from '../../src/modules/messaging/application/wager-delivery-policy';
import { InvalidWagerMessageError } from '../../src/modules/messaging/application/wager-requested';
import { WagerProcessingRetryableError } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';

const config: SqsWagerConfiguration = { endpoint: 'http://localhost:4566', region: 'us-east-1',
  queueUrl: 'http://localhost:4566/000000000000/wager-transactions.fifo', visibilityTimeout: 30, waitTimeSeconds: 0 };
const dlqUrl = 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';
const raw: ReceivedRawWagerRequest = Object.freeze({ body: '  {broken JSON: "ação"\n', sqsMessageId: 'source-message',
  receiptHandle: 'receipt-1', messageGroupId: 'wallet-group', approximateReceiveCount: '1' });
const failure: WagerDeliveryFailure = Object.freeze({ phase: 'validation', error: new InvalidWagerMessageError(), financialOutcome: { kind: 'not-started' as const } });
const confirmed = (): SendMessageCommandOutput => ({ $metadata: { httpStatusCode: 200 }, MessageId: 'dlq-message',
  SequenceNumber: '340282366920938463463374607431768211455', MD5OfMessageBody: createHash('md5').update(raw.body!).digest('hex') });
type Command = GetQueueAttributesCommand | SendMessageCommand | DeleteMessageCommand;
type Output = GetQueueAttributesCommandOutput & SendMessageCommandOutput & DeleteMessageCommandOutput;
function fixture(options: {
  attributes?: GetQueueAttributesCommandOutput; destinationAttributes?: GetQueueAttributesCommandOutput;
  publication?: SendMessageCommandOutput; ack?: DeleteMessageCommandOutput;
  failAt?: 'configuration' | 'destination-configuration' | 'dlq' | 'ack'; cause?: unknown;
} = {}) {
  const send = mock(async (command: Command): Promise<Output> => {
    const phase = command instanceof GetQueueAttributesCommand
      ? command.input.QueueUrl === dlqUrl ? 'destination-configuration' : 'configuration'
      : command instanceof SendMessageCommand ? 'dlq' : 'ack';
    if (phase === options.failAt) throw options.cause;
    if (command instanceof GetQueueAttributesCommand) return (phase === 'destination-configuration' ? options.destinationAttributes : options.attributes)
      ?? { $metadata: { httpStatusCode: 200 }, Attributes: { FifoQueue: 'true' } };
    if (command instanceof SendMessageCommand) return options.publication ?? confirmed();
    return options.ack ?? { $metadata: { httpStatusCode: 200 } };
  });
  return { send, adapter: new SqsWagerDlq({ send }, config, dlqUrl) };
}

test('explicit DLQ preserves the raw body and original group, then deletes only the source', async () => {
  const f = fixture(); expect(f.send).not.toHaveBeenCalled();
  const result = await f.adapter.apply(raw, failure);
  expect(result).toMatchObject({ kind: 'forwarded', decision: { action: 'send-to-dlq' }, publication: { kind: 'confirmed', messageId: 'dlq-message' } });
  const commands = f.send.mock.calls.map(([command]) => command);
  expect(commands.map(command => command.constructor)).toEqual([GetQueueAttributesCommand, GetQueueAttributesCommand, SendMessageCommand, DeleteMessageCommand]);
  expect(commands[0]!.input).toEqual({ QueueUrl: config.queueUrl, AttributeNames: ['FifoQueue', 'RedrivePolicy'] });
  expect(commands[1]!.input).toEqual({ QueueUrl: dlqUrl, AttributeNames: ['FifoQueue'] });
  const sent = commands[2] as SendMessageCommand;
  const transferId = createHash('sha256').update(JSON.stringify(['wager-dlq-v1', config.queueUrl, raw.sqsMessageId])).digest('hex');
  expect(sent.input).toEqual({ QueueUrl: dlqUrl, MessageBody: raw.body, MessageGroupId: raw.messageGroupId, MessageDeduplicationId: transferId,
    MessageAttributes: { sourceQueueUrl: { DataType: 'String', StringValue: config.queueUrl },
      sourceMessageId: { DataType: 'String', StringValue: raw.sqsMessageId }, dlqTransferId: { DataType: 'String', StringValue: transferId } } });
  expect(commands[3]!.input).toEqual({ QueueUrl: config.queueUrl, ReceiptHandle: raw.receiptHandle });
});

test('DeleteMessage waits for SendMessage to resolve with valid confirmation', async () => {
  let entered!: () => void; const publishing = new Promise<void>(resolve => { entered = resolve; });
  let confirm!: (value: SendMessageCommandOutput) => void; const publication = new Promise<SendMessageCommandOutput>(resolve => { confirm = resolve; });
  const send = mock(async (command: Command): Promise<Output> => {
    if (command instanceof GetQueueAttributesCommand) return { $metadata: { httpStatusCode: 200 }, Attributes: { FifoQueue: 'true' } };
    if (command instanceof SendMessageCommand) { entered(); return publication; }
    return { $metadata: { httpStatusCode: 200 } };
  });
  const pending = new SqsWagerDlq({ send }, config, dlqUrl).apply(raw, failure);
  try { await publishing; expect(send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(false); }
  finally { confirm(confirmed()); }
  expect((await pending).kind).toBe('forwarded'); expect(send).toHaveBeenCalledTimes(4);
});

test.each([
  ['body', undefined], ['body', ''], ['sqsMessageId', undefined], ['sqsMessageId', ''], ['sqsMessageId', 'bad id'],
  ['receiptHandle', undefined], ['receiptHandle', ''], ['receiptHandle', 'receipt\n'],
  ['messageGroupId', undefined], ['messageGroupId', ''], ['messageGroupId', 'bad group'], ['messageGroupId', 'x'.repeat(129)],
  ['approximateReceiveCount', undefined], ['approximateReceiveCount', '0'], ['approximateReceiveCount', '1\n'],
  ['approximateReceiveCount', '01'], ['approximateReceiveCount', '1.5'], ['approximateReceiveCount', '9007199254740992'],
].map(([field, value]) => ({ field: field!, value })))('invalid metadata %# blocks publication and deletion with a diagnostic field', async ({ field, value }) => {
  const f = fixture();
  await expect(f.adapter.apply({ ...raw, [field]: value }, failure)).rejects.toMatchObject({
    name: 'SqsWagerDlqError', code: 'INVALID_DLQ_METADATA', phase: 'validation', publication: { kind: 'not-attempted' }, originalFailure: failure,
  });
  await expect(f.adapter.apply({ ...raw, [field]: value }, failure)).rejects.toThrow(field);
  expect(f.send).not.toHaveBeenCalled();
});

test.each([
  {}, { FifoQueue: 'false' }, { FifoQueue: 'true', RedrivePolicy: '{"maxReceiveCount":"3"}' },
  { FifoQueue: 'true', RedrivePolicy: '{"maxReceiveCount":"5"}' }, { FifoQueue: 'true', RedrivePolicy: '' },
])('unsafe source attributes %# block explicit mode', async Attributes => {
  const f = fixture({ attributes: { $metadata: { httpStatusCode: 200 }, Attributes } });
  await expect(f.adapter.apply(raw, failure)).rejects.toMatchObject({ code: 'UNSAFE_DLQ_CONFIGURATION', phase: 'configuration', publication: { kind: 'not-attempted' } });
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0]![0]).toBeInstanceOf(GetQueueAttributesCommand);
});

test.each([
  { $metadata: {} }, { $metadata: { httpStatusCode: 500 }, Attributes: { FifoQueue: 'true' } },
])('incomplete or unsuccessful queue verification %# blocks sending', async attributes => {
  const f = fixture({ attributes });
  await expect(f.adapter.apply(raw, failure)).rejects.toMatchObject({ code: 'UNSAFE_DLQ_CONFIGURATION' });
  expect(f.send).toHaveBeenCalledTimes(1);
});

test.each([
  { $metadata: { httpStatusCode: 200 }, Attributes: { FifoQueue: 'false' } },
  { $metadata: { httpStatusCode: 200 }, Attributes: {} },
  { $metadata: { httpStatusCode: 200 } },
  { $metadata: {}, Attributes: { FifoQueue: 'true' } },
  { $metadata: { httpStatusCode: 500 }, Attributes: { FifoQueue: 'true' } },
])('non-FIFO or incomplete destination verification %# blocks publication and deletion', async destinationAttributes => {
  const f = fixture({ destinationAttributes });
  const pending = f.adapter.apply(raw, failure);
  await expect(pending).rejects.toMatchObject({ code: 'UNSAFE_DLQ_CONFIGURATION', phase: 'configuration',
    publication: { kind: 'not-attempted' }, originalFailure: failure });
  await expect(pending).rejects.toThrow('destination DLQ');
  expect(f.send.mock.calls.map(([command]) => [command.constructor, command.input.QueueUrl]))
    .toEqual([[GetQueueAttributesCommand, config.queueUrl], [GetQueueAttributesCommand, dlqUrl]]);
});

test('destination attribute lookup failure is diagnostic and blocks publication and deletion', async () => {
  const cause = new Error('destination attributes unavailable'); const f = fixture({ failAt: 'destination-configuration', cause });
  const pending = f.adapter.apply(raw, failure);
  await expect(pending).rejects.toMatchObject({ code: 'DLQ_CONFIGURATION_CHECK_FAILED', phase: 'configuration',
    publication: { kind: 'not-attempted' }, originalFailure: failure, cause });
  await expect(pending).rejects.toThrow('destination DLQ');
  expect(f.send.mock.calls.map(([command]) => [command.constructor, command.input.QueueUrl]))
    .toEqual([[GetQueueAttributesCommand, config.queueUrl], [GetQueueAttributesCommand, dlqUrl]]);
});

test('preflight is explicit and both queues are rechecked on each eligible delivery', async () => {
  const f = fixture(); await f.adapter.assertExplicitMode();
  await f.adapter.apply(raw, failure); await f.adapter.apply({ ...raw, receiptHandle: 'fresh' }, failure);
  expect(f.send.mock.calls.filter(([command]) => command instanceof GetQueueAttributesCommand).map(([command]) => command.input.QueueUrl))
    .toEqual([config.queueUrl, dlqUrl, config.queueUrl, dlqUrl, config.queueUrl, dlqUrl]);
});

test.each([
  {}, { $metadata: { httpStatusCode: 500 } }, { MessageId: undefined }, { MessageId: 'bad id' }, { SequenceNumber: undefined },
  { SequenceNumber: '-1' }, { SequenceNumber: '1.5' }, { SequenceNumber: '1\n' }, { SequenceNumber: '340282366920938463463374607431768211456' },
  { MD5OfMessageBody: undefined }, { MD5OfMessageBody: '0'.repeat(32) },
].map((override, index) => ({ publication: index === 0 ? { $metadata: {} } : { ...confirmed(), ...override } })))('unconfirmed FIFO response %# never authorizes deletion', async ({ publication }) => {
  const f = fixture({ publication });
  await expect(f.adapter.apply(raw, failure)).rejects.toMatchObject({ code: 'DLQ_PUBLISH_UNCONFIRMED', phase: 'dlq', publication: { kind: 'uncertain' }, originalFailure: failure });
  expect(f.send).toHaveBeenCalledTimes(3); expect(f.send.mock.calls[2]![0]).toBeInstanceOf(SendMessageCommand);
});

test.each(['configuration', 'dlq', 'ack'] as const)('failure in %s preserves its stage and cause without implying financial rollback', async failAt => {
  const cause = new Error('response lost'); const f = fixture({ failAt, cause });
  const expected = { configuration: ['DLQ_CONFIGURATION_CHECK_FAILED', 'not-attempted', 1], dlq: ['DLQ_PUBLISH_FAILED', 'uncertain', 3], ack: ['DLQ_ACK_FAILED', 'confirmed', 4] }[failAt];
  await expect(f.adapter.apply(raw, failure)).rejects.toMatchObject({ code: expected[0], phase: failAt, publication: { kind: expected[1] }, cause, originalFailure: failure });
  expect(f.send).toHaveBeenCalledTimes(expected[2] as number);
});

test('missing ACK confirmation remains an ACK error with confirmed DLQ publication', async () => {
  const f = fixture({ ack: { $metadata: {} } });
  await expect(f.adapter.apply(raw, failure)).rejects.toMatchObject({ code: 'DLQ_ACK_UNCONFIRMED', phase: 'ack', publication: { kind: 'confirmed' } });
});

test('redelivery after ACK failure republishes with the same stable identity and current receipt', async () => {
  const f = fixture({ failAt: 'ack', cause: new Error('ACK lost') });
  await expect(f.adapter.apply(raw, failure)).rejects.toBeInstanceOf(SqsWagerDlqError);
  await expect(f.adapter.apply({ ...raw, receiptHandle: 'receipt-2', approximateReceiveCount: '2' }, failure)).rejects.toBeInstanceOf(SqsWagerDlqError);
  const sends = f.send.mock.calls.map(([command]) => command).filter((command): command is SendMessageCommand => command instanceof SendMessageCommand);
  expect(sends).toHaveLength(2); expect(sends[0]!.input).toEqual(sends[1]!.input);
  const deletes = f.send.mock.calls.map(([command]) => command).filter((command): command is DeleteMessageCommand => command instanceof DeleteMessageCommand);
  expect(deletes.map(command => command.input.ReceiptHandle)).toEqual(['receipt-1', 'receipt-2']);
});

test('transport identity distinguishes source messages and source queues even with identical bodies', async () => {
  const f = fixture(); await f.adapter.apply(raw, failure); await f.adapter.apply({ ...raw, sqsMessageId: 'another-message' }, failure);
  await new SqsWagerDlq({ send: f.send }, { ...config, queueUrl: config.queueUrl.replace('wager-transactions.fifo', 'another-source.fifo') }, dlqUrl).apply(raw, failure);
  const ids = f.send.mock.calls.map(([command]) => command).filter((command): command is SendMessageCommand => command instanceof SendMessageCommand).map(command => command.input.MessageDeduplicationId);
  expect(new Set(ids).size).toBe(3);
});

test('policy authorizes exhausted known transient failure only with independent rollback evidence', async () => {
  const f = fixture(); const error = new WagerProcessingRetryableError('40001', undefined);
  for (const phase of ['processing', 'commit'] as const) {
    expect(await f.adapter.apply({ ...raw, approximateReceiveCount: '5' }, { phase, error, financialOutcome: { kind: 'uncertain' } }))
      .toMatchObject({ kind: 'deferred', decision: { action: 'hold' } });
  }
  expect(f.send).not.toHaveBeenCalled();
  expect(await f.adapter.apply({ ...raw, approximateReceiveCount: '5' }, { phase: 'processing', error, financialOutcome: { kind: 'rolled-back' } })).toMatchObject({ kind: 'forwarded' });
});

test.each([Status.Processed, Status.Rejected, Status.PendingReference] as const)('persisted %s never goes to DLQ after ACK failure or exhaustion', async status => {
  const f = fixture();
  for (const phase of ['ack', 'processing'] as const) {
    expect(await f.adapter.apply({ ...raw, approximateReceiveCount: '5' }, { phase, error: new WagerProcessingRetryableError('40001', undefined),
      financialOutcome: { kind: 'persisted', result: { transactionId: 'transaction', status, balance: { amount: '0.00', currency: 'BRL' }, idempotentReplay: true } } }))
      .toMatchObject({ kind: 'deferred', decision: { action: 'hold' } });
  }
  expect(f.send).not.toHaveBeenCalled();
});

test('unknown errors and retry decisions perform no queue operations', async () => {
  const f = fixture();
  for (const error of [new Error('unknown'), new WagerProcessingRetryableError('40001', undefined)]) {
    expect((await f.adapter.apply(raw, { phase: 'processing', error, financialOutcome: { kind: 'rolled-back' } })).kind).toBe('deferred');
  }
  expect(f.send).not.toHaveBeenCalled();
});

test('same source and destination or a non-FIFO destination are rejected before commands', () => {
  const f = fixture();
  expect(() => new SqsWagerDlq({ send: f.send }, config, config.queueUrl)).toThrow(SqsWagerDlqError);
  expect(() => new SqsWagerDlq({ send: f.send }, config, dlqUrl.replace('.fifo', ''))).toThrow();
  expect(f.send).not.toHaveBeenCalled();
});
