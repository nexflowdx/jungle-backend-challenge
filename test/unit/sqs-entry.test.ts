import 'reflect-metadata';
import { expect, mock, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { ReceiveMessageCommand, type Message, type ReceiveMessageCommandOutput } from '@aws-sdk/client-sqs';
import { parseWagerTransactionRequested, InvalidWagerMessageError } from '../../src/modules/messaging/application/wager-requested';
import { SqsWagerCommandHandler } from '../../src/modules/messaging/application/sqs-wager-command-handler';
import { SqsWagerReceiver, createSqsWagerClient, type SqsWagerConfiguration } from '../../src/modules/messaging/infrastructure/sqs-wager-receiver';
import { MessagingModule } from '../../src/modules/messaging/messaging.module';
import { ProcessWagerTransaction, type ProcessWagerTransactionResult } from '../../src/modules/wagering/application/process-wager-transaction';
import { WagerRequestFingerprint } from '../../src/modules/wagering/application/wager-request-fingerprint';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { createHttpApplication } from '../../src/http/http-api.module';
import { HttpMemoryPersistence } from '../helpers/http-memory-persistence';
import { httpRequest } from '../helpers/http-request';

const event = () => ({ messageId: 'event-123', type: 'WagerTransactionRequested' as const, occurredAt: '2026-07-29T15:00:00.000Z',
  data: { providerId: 'provider-a', externalTransactionId: 'external-123', idempotencyKey: 'provider-a:external-123',
    playerId: 'player', walletId: 'wallet', roundId: 'round', gameId: 'game', kind: Kind.Bet as const, money: { amount: '25.00', currency: 'BRL' } } });
const config: SqsWagerConfiguration = { endpoint: 'http://localhost:4566', region: 'us-east-1',
  queueUrl: 'http://localhost:4566/000000000000/wager-transactions.fifo', visibilityTimeout: 45, waitTimeSeconds: 10 };
const delivered = (body = event()): Message => ({ MessageId: 'aws-generated-id', ReceiptHandle: 'opaque-receipt',
  Attributes: { MessageGroupId: 'wallet-group' }, Body: JSON.stringify(body) });
const stub = (messages?: readonly Message[]) => ({ send: mock(async (_command: ReceiveMessageCommand): Promise<ReceiveMessageCommandOutput> =>
  ({ $metadata: {}, ...(messages === undefined ? {} : { Messages: [...messages] }) })) });
const result: ProcessWagerTransactionResult = { transactionId: 'persisted-transaction', status: Status.Processed,
  balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false };

test.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])('SQS contract accepts external kind %s using domain validation', kind => {
  const data = { ...event().data, kind, ...(kind === Kind.Refund || kind === Kind.Rollback ? { referenceExternalTransactionId: 'original' } : {}) };
  expect(parseWagerTransactionRequested({ ...event(), data }).data).toEqual(data);
});
test.each(['BRL', 'USD'])('SQS preserves exact monetary maximum in %s and normalizes leading zeroes without numbers', currency => {
  const data = { ...event().data, money: { amount: '92233720368547758.07', currency } };
  expect(parseWagerTransactionRequested({ ...event(), data }).data.money.amount).toBe(data.money.amount);
  data.money.amount = '00025.00'; expect(parseWagerTransactionRequested({ ...event(), data }).data.money).toEqual({ amount: '25.00', currency });
});
test('LOSS accepts zero while WIN with optional reference keeps it', () => {
  expect(parseWagerTransactionRequested({ ...event(), data: { ...event().data, kind: 'LOSS', money: { amount: '0.00', currency: 'USD' } } }).data.money.amount).toBe('0.00');
  expect(parseWagerTransactionRequested({ ...event(), data: { ...event().data, kind: 'WIN', referenceExternalTransactionId: 'bet' } }).data.referenceExternalTransactionId).toBe('bet');
});
test.each([null, [], {}, 'event', { ...event(), messageId: 1 }, { ...event(), messageId: ' ' }, { ...event(), type: 'WalletBalanceChanged' },
  { ...event(), occurredAt: 123 }, { ...event(), occurredAt: 'invalid' }, { ...event(), occurredAt: '2026-02-30T15:00:00Z' },
  { ...event(), occurredAt: '2026-07-29' }, { ...event(), data: [] }, { ...event(), extra: true },
].map(input => ({ input })))('invalid SQS envelope %# fails before dispatch', ({ input }) => {
  const execute = mock(async () => result); const handler = new SqsWagerCommandHandler({ execute });
  expect(() => handler.execute(input)).toThrow(InvalidWagerMessageError); expect(execute).not.toHaveBeenCalled();
});
test.each(['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money'])('SQS requires data.%s', field => {
  const data: Record<string, unknown> = { ...event().data }; delete data[field];
  expect(() => parseWagerTransactionRequested({ ...event(), data })).toThrow(InvalidWagerMessageError);
});
test.each([{ providerId: ' ' }, { idempotencyKey: 123 }, { walletId: null }, { playerId: [] }, { kind: 'OPENING' }, { kind: 'other' },
  { money: { amount: 25, currency: 'BRL' } }, { money: { amount: '25.001', currency: 'BRL' } },
  { money: { amount: '1e2', currency: 'BRL' } }, { money: { amount: '25', currency: 'BRL' } },
  { money: { amount: '-1.00', currency: 'BRL' } }, { money: { amount: '0.00', currency: 'BRL' } },
  { money: { amount: '92233720368547758.08', currency: 'BRL' } }, { money: { amount: '25.00', currency: 'EUR' } },
  { money: { amount: '25.00', currency: 1 } }, { money: { amount: '25.00', currency: 'BRL', extra: true } },
  { money: null }, { money: [] }, { kind: 'REFUND' }, { kind: 'ROLLBACK' }, { referenceExternalTransactionId: 'original' },
  { kind: 'LOSS', referenceExternalTransactionId: 'original' }, { kind: 'WIN', referenceExternalTransactionId: null },
  { correlationId: 'transport-data' }, { payloadHash: 'supplied' },
])('invalid SQS business data %# fails before the use case', override => {
  const execute = mock(async () => result);
  expect(() => new SqsWagerCommandHandler({ execute }).execute({ ...event(), data: { ...event().data, ...override } })).toThrow(InvalidWagerMessageError);
  expect(execute).not.toHaveBeenCalled();
});
test('dispatch projects only business fields and uses the envelope ID solely as event context', async () => {
  const execute = mock(async () => result); const handler = new SqsWagerCommandHandler({ execute });
  expect(await handler.execute(event())).toBe(result);
  const input = execute.mock.calls[0]; expect(input).toBeDefined();
  // Use a typed capture separately; the spy above intentionally supplies no financial implementation.
  let command: Parameters<ProcessWagerTransaction['execute']>[0] | undefined;
  await new SqsWagerCommandHandler({ execute: async value => { command = value; return result; } }).execute(event());
  expect(command).toEqual({ ...event().data, correlationId: 'event-123', causationId: 'event-123' });
  const first = WagerRequestFingerprint.from({ ...parseWagerTransactionRequested(event()).data });
  const changed = parseWagerTransactionRequested({ ...event(), messageId: 'redelivery-envelope', occurredAt: '2026-07-30T15:00:00Z' });
  expect(WagerRequestFingerprint.from(changed.data).payloadHash).toBe(first.payloadHash);
});
test.each([result, { ...result, idempotentReplay: true }, { ...result, status: Status.PendingReference },
  { ...result, status: Status.Rejected, failureCode: FailureCode.InsufficientFunds }])('handler returns the exact application result unchanged %#', async response => {
  expect(await new SqsWagerCommandHandler({ execute: async () => response }).execute(event())).toBe(response);
});
test('handler propagates application failures without constructing a result', async () => {
  const failure = new Error('application unavailable');
  await expect(new SqsWagerCommandHandler({ execute: async () => { throw failure; } }).execute(event())).rejects.toBe(failure);
});
test('receiver issues exactly one AWS ReceiveMessage command with explicit FIFO attributes and visibility', async () => {
  const client = stub([delivered()]); const receiver = new SqsWagerReceiver(client, config);
  expect(client.send).not.toHaveBeenCalled();
  expect(await receiver.receiveOnce()).toEqual({ sqsMessageId: 'aws-generated-id', receiptHandle: 'opaque-receipt', messageGroupId: 'wallet-group', envelope: event() });
  expect(client.send).toHaveBeenCalledTimes(1); const command = client.send.mock.calls[0]![0];
  expect(command).toBeInstanceOf(ReceiveMessageCommand);
  expect(command.input).toEqual({ QueueUrl: config.queueUrl, MaxNumberOfMessages: 1, VisibilityTimeout: 45, WaitTimeSeconds: 10, MessageSystemAttributeNames: ['MessageGroupId'] });
});
test.each([undefined, []].map(messages => ({ messages })))('empty SQS receive %# returns no financial result', async ({ messages }) => {
  expect(await new SqsWagerReceiver(stub(messages), config).receiveOnce()).toBeUndefined();
});
test.each([{ Body: undefined }, { Body: '{broken' }, { Body: 'null' }, { MessageId: undefined }, { ReceiptHandle: undefined },
  { Attributes: undefined }, { Attributes: { MessageGroupId: '' } }, { Attributes: { MessageGroupId: 'with space' } },
])('invalid SQS delivery metadata or body %# is rejected without acknowledgement', async override => {
  // The SDK may omit fields, even though accepted deliveries require them.
  const message = { ...delivered(), ...override } as Message; const client = stub([message]);
  await expect(new SqsWagerReceiver(client, config).receiveOnce()).rejects.toBeInstanceOf(InvalidWagerMessageError);
  expect(client.send).toHaveBeenCalledTimes(1); expect(client.send.mock.calls[0]![0]).toBeInstanceOf(ReceiveMessageCommand);
});
test('receiver propagates SDK errors unchanged, without retry or fabricated success', async () => {
  const failure = new Error('SQS unavailable'); const send = mock(async (_command: ReceiveMessageCommand): Promise<ReceiveMessageCommandOutput> => { throw failure; });
  await expect(new SqsWagerReceiver({ send }, config).receiveOnce()).rejects.toBe(failure); expect(send).toHaveBeenCalledTimes(1);
});
test.each([{ endpoint: '' }, { endpoint: 'file:///tmp/queue' }, { endpoint: 'http://user:password@localhost' }, { region: '' },
  { queueUrl: 'not-a-url' }, { queueUrl: 'http://localhost/standard-queue' }, { visibilityTimeout: -1 }, { visibilityTimeout: 43201 },
  { visibilityTimeout: 1.5 }, { visibilityTimeout: '45' }, { waitTimeSeconds: -1 }, { waitTimeSeconds: 21 }, { waitTimeSeconds: NaN },
])('invalid SQS configuration %# fails before receiving', override => {
  const client = stub(); expect(() => new SqsWagerReceiver(client, { ...config, ...override } as SqsWagerConfiguration)).toThrow('Invalid SQS wagering configuration');
  expect(client.send).not.toHaveBeenCalled();
});
test('SDK client uses the explicit endpoint, region, credentials and one attempt; creation sends nothing', async () => {
  const client = createSqsWagerClient(config, { accessKeyId: 'emulator-only', secretAccessKey: 'emulator-only' });
  try {
    expect(await client.config.region()).toBe(config.region); expect(await client.config.maxAttempts()).toBe(1);
    expect(client.config.useQueueUrlAsEndpoint).toBe(false); expect((await client.config.endpoint!()).hostname).toBe('localhost');
    expect((await client.config.credentials()).accessKeyId).toBe('emulator-only');
  } finally { client.destroy(); }
});
test('Nest composition shares the HTTP use case explicitly; startup never polls or processes', async () => {
  const persistence = new HttpMemoryPersistence(); const http = await createHttpApplication(persistence, { logger: false });
  let messaging: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  try {
    await http.init(); const process = http.get(ProcessWagerTransaction); const receiverClient = stub([delivered()]);
    const client = { send: mock(async (command: ReceiveMessageCommand | import('@aws-sdk/client-sqs').DeleteMessageCommand) => {
      if (command instanceof ReceiveMessageCommand) return receiverClient.send(command);
      return { $metadata: {} };
    }) };
    messaging = await NestFactory.createApplicationContext(MessagingModule.register({ processTransaction: process, client, configuration: config }), { logger: false, abortOnError: false });
    expect(messaging.get(ProcessWagerTransaction)).toBe(process); expect(client.send).not.toHaveBeenCalled(); expect(persistence.calls).toBe(0);
    const wallet = await httpRequest(http, '/wallets', { playerId: 'player', initialBalance: { amount: '100.00', currency: 'BRL' } });
    const data = { ...event().data, walletId: (wallet.body as { id: string }).id };
    const { idempotencyKey, ...body } = data;
    const original = await httpRequest(http, '/wagering/transactions', body, [['Idempotency-Key', idempotencyKey]]);
    expect(original.status).toBe(200);
    const receiver = new SqsWagerReceiver(stub([delivered({ ...event(), data })]), config); const received = await receiver.receiveOnce();
    const handler = messaging.get(SqsWagerCommandHandler);
    expect(await handler.execute(received!.envelope)).toEqual({ ...original.body as ProcessWagerTransactionResult, idempotentReplay: true });
    expect(persistence.wallets.get(data.walletId)!.balance.toString()).toBe('75.00'); expect(persistence.ledger).toHaveLength(2);
    expect(client.send).not.toHaveBeenCalled(); // Dispatch does not poll, delete or acknowledge.
  } finally { if (messaging) await messaging.close(); await http.close(); }
});
