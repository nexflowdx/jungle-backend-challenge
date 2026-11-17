import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createHttpApplication } from '../../src/http/http-api.module';
import { HttpMemoryPersistence } from '../helpers/http-memory-persistence';
import { httpRequest } from '../helpers/http-request';
import { WagerTransactionIdentity } from '../../src/modules/wagering/application/wager-transaction-identity';
import { WagerProcessingRetryableError } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';

const wallet = { playerId: 'player', initialBalance: { amount: '100.00', currency: 'BRL' } };
describe('HTTP contract through NestJS and Express (unit ports, no PostgreSQL)', () => {
  let application: INestApplication; let persistence: HttpMemoryPersistence;
  beforeEach(async () => { persistence = new HttpMemoryPersistence(); application = await createHttpApplication(persistence, { logger: false }); await application.init(); });
  afterEach(async () => { if (application) await application.close(); });
  const wager = (walletId: string, kind = 'BET', externalTransactionId = 'external') => ({ providerId: 'provider', externalTransactionId, playerId: 'player', walletId, roundId: 'round', gameId: 'game', kind, money: { amount: '25.00', currency: 'BRL' } });
  const key = (value = 'key'): [string, string][] => [['Idempotency-Key', value]];
  const open = async () => (await httpRequest(application, '/wallets', wallet)).body as { id: string };
  test('creates a wallet with the real use case and returns its decimal snapshot', async () => {
    const response = await httpRequest(application, '/wallets', wallet);
    expect(response.status).toBe(201); expect(response.body).toMatchObject({ playerId: 'player', balance: wallet.initialBalance, version: 1 });
    expect(persistence.wallets.size).toBe(1); expect(persistence.ledger).toHaveLength(1);
  });
  test('zero opening and duplicate wallet preserve the existing financial semantics', async () => {
    const input = { ...wallet, initialBalance: { amount: '0.00', currency: 'USD' } };
    expect((await httpRequest(application, '/wallets', input)).status).toBe(201);
    expect(persistence.ledger).toHaveLength(0); expect(persistence.transactions.size).toBe(0);
    const duplicate = await httpRequest(application, '/wallets', input);
    expect(duplicate).toMatchObject({ status: 409, body: { code: 'WALLET_ALREADY_EXISTS' } }); expect(persistence.wallets.size).toBe(1);
  });
  test.each([null, [], {}, { ...wallet, playerId: 42 }, { ...wallet, playerId: ' ' }, { ...wallet, unexpected: true },
    { ...wallet, initialBalance: null }, { ...wallet, initialBalance: [] }, { ...wallet, initialBalance: { amount: 100, currency: 'BRL' } },
    { ...wallet, initialBalance: { amount: '1.001', currency: 'BRL' } }, { ...wallet, initialBalance: { amount: '-1.00', currency: 'BRL' } },
    { ...wallet, initialBalance: { amount: '1e2', currency: 'BRL' } }, { ...wallet, initialBalance: { amount: 'NaN', currency: 'BRL' } },
    { ...wallet, initialBalance: { amount: '1.00', currency: 'EUR' } }, { ...wallet, initialBalance: { amount: '92233720368547758.08', currency: 'BRL' } },
    { ...wallet, initialBalance: { amount: '1.00', currency: 'BRL', extra: 1 } },
  ])('invalid wallet body %# is rejected before the use case', async body => {
    expect((await httpRequest(application, '/wallets', body)).status).toBe(400); expect(persistence.calls).toBe(0);
  });
  test.each(([[], [['Idempotency-Key', '']], [['Idempotency-Key', ' ']], [['Idempotency-Key', 'with space']], [['Idempotency-Key', 'a,b']],
    [['Idempotency-Key', 'a'], ['idempotency-key', 'b']], [['Idempotency-Key', 'a\tb']], [['Idempotency-Key', 'chave-é']],
  ] as [string, string][][]).map(headers => ({ headers })))('invalid or missing header %# is rejected before persistence', async ({ headers }) => {
    expect((await httpRequest(application, '/wagering/transactions', wager('wallet'), headers)).status).toBe(400); expect(persistence.calls).toBe(0);
  });
  test.each([
    {}, { walletId: 123 }, { providerId: '' }, { externalTransactionId: null }, { kind: 'OPENING' }, { kind: 'UNKNOWN' }, { kind: 1 },
    { money: { amount: 25, currency: 'BRL' } }, { money: { amount: '25', currency: 'BRL' } }, { money: { amount: '25.001', currency: 'BRL' } },
    { money: { amount: '0.00', currency: 'BRL' } }, { money: { amount: '1.00', currency: 'brl' } }, { money: { amount: '1.00', currency: 1 } },
    { money: { amount: '1.00', currency: 'BRL', extra: true } }, { money: { amount: '92233720368547758.08', currency: 'BRL' } },
    { idempotencyKey: 'body-key' }, { payloadHash: 'supplied' }, { correlationId: 'supplied' }, { referenceExternalTransactionId: null },
    { referenceExternalTransactionId: 'reference' }, { kind: 'REFUND' }, { kind: 'ROLLBACK' },
  ])('invalid transaction body %# is rejected before the use case', async override => {
    const body = Object.keys(override).length ? { ...wager('wallet'), ...override } : {};
    expect((await httpRequest(application, '/wagering/transactions', body, key())).status).toBe(400); expect(persistence.calls).toBe(0);
  });
  test('malformed JSON is a sanitized contract error before the use case', async () => {
    const result = await httpRequest(application, '/wallets', {}, [], '{broken');
    expect(result).toEqual({ status: 400, body: { code: 'INVALID_REQUEST', message: 'Invalid request' } }); expect(persistence.calls).toBe(0);
  });
  test('BET returns 200, preserves the historical replay, and excludes transport metadata from its hash', async () => {
    const target = await open(); const input = wager(target.id);
    const first = await httpRequest(application, '/wagering/transactions', input, [...key(), ['X-Correlation-Id', 'first']]);
    expect(first).toMatchObject({ status: 200, body: { status: Status.Processed, balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false } });
    const original = first.body as { transactionId: string }; const hash = persistence.transactions.get(original.transactionId)!.payloadHash;
    await httpRequest(application, '/wagering/transactions', { ...wager(target.id, 'WIN', 'later'), money: { amount: '10.00', currency: 'BRL' } }, key('later'));
    const counts = [persistence.ledger.length, persistence.events.length, persistence.transactions.size];
    const replay = await httpRequest(application, '/wagering/transactions', input, [...key(), ['X-Correlation-Id', 'second']]);
    expect(replay).toEqual({ status: 200, body: { ...first.body as object, idempotentReplay: true } });
    expect(persistence.wallets.get(target.id)!.balance.toString()).toBe('85.00');
    expect([persistence.ledger.length, persistence.events.length, persistence.transactions.size]).toEqual(counts);
    expect(persistence.transactions.get(original.transactionId)!.payloadHash).toBe(hash);
    expect((await httpRequest(application, '/wagering/transactions', { ...input, money: { amount: '26.00', currency: 'BRL' } }, key())).status).toBe(409);
    expect((await httpRequest(application, '/wagering/transactions', input, key('other'))).body).toMatchObject({ reason: 'EXTERNAL_ID_REUSED' });
    expect([persistence.ledger.length, persistence.events.length, persistence.transactions.size]).toEqual(counts);
  });
  test('business rejection returns 422 with stable failureCode and no financial movement', async () => {
    const target = await open(); const input = { ...wager(target.id), money: { amount: '101.00', currency: 'BRL' } };
    const first = await httpRequest(application, '/wagering/transactions', input, key());
    expect(first).toMatchObject({ status: 422, body: { status: Status.Rejected, failureCode: FailureCode.InsufficientFunds, balance: wallet.initialBalance, idempotentReplay: false } });
    expect(persistence.wallets.get(target.id)!.version).toBe(1); expect(persistence.ledger).toHaveLength(1);
    expect(persistence.events.at(-1)!.eventType).toBe('WagerTransactionRejected');
    expect(await httpRequest(application, '/wagering/transactions', input, key())).toEqual({ status: 422, body: { ...first.body as object, idempotentReplay: true } });
  });
  test.each(['WIN', 'REFUND', 'ROLLBACK'])('%s missing reference returns 202 and stays pending on replay after reference arrival', async kind => {
    const target = await open(); const input = { ...wager(target.id, kind), referenceExternalTransactionId: 'later' };
    const first = await httpRequest(application, '/wagering/transactions', input, key());
    expect(first).toMatchObject({ status: 202, body: { status: Status.PendingReference, balance: wallet.initialBalance, idempotentReplay: false } });
    expect(persistence.ledger).toHaveLength(1); expect(persistence.wallets.get(target.id)!.version).toBe(1);
    await httpRequest(application, '/wagering/transactions', wager(target.id, 'BET', 'later'), key('later'));
    const counts = [persistence.ledger.length, persistence.events.length];
    expect(await httpRequest(application, '/wagering/transactions', input, key())).toEqual({ status: 202, body: { ...first.body as object, idempotentReplay: true } });
    expect(persistence.wallets.get(target.id)!.balance.toString()).toBe('75.00'); expect([persistence.ledger.length, persistence.events.length]).toEqual(counts);
  });
  test.each(['WIN', 'LOSS', 'REFUND', 'ROLLBACK'])('%s routes to the real domain processing', async kind => {
    const target = await open(); let input = wager(target.id, kind);
    if (kind === 'REFUND' || kind === 'ROLLBACK') {
      await httpRequest(application, '/wagering/transactions', wager(target.id, 'BET', 'reference'), key('reference'));
      input = { ...input, referenceExternalTransactionId: 'reference' } as typeof input;
    }
    const result = await httpRequest(application, '/wagering/transactions', input, key());
    expect(result).toMatchObject({ status: 200, body: { status: Status.Processed, balance: { amount: kind === 'WIN' ? '125.00' : '100.00', currency: 'BRL' } } });
    expect(persistence.wallets.get(target.id)!.version).toBe(kind === 'LOSS' ? 1 : kind === 'WIN' ? 2 : 3);
  });
  test('LOSS permits zero without a ledger entry or balance event', async () => {
    const target = await open(); const input = { ...wager(target.id, 'LOSS'), money: { amount: '0.00', currency: 'BRL' } };
    expect((await httpRequest(application, '/wagering/transactions', input, key())).status).toBe(200);
    expect(persistence.ledger).toHaveLength(1); expect(persistence.events.at(-1)!.eventType).toBe('WagerTransactionProcessed');
  });
  test('wallet routing mismatch is an explicit business error, never a fake financial result', async () => {
    const target = await open(); const result = await httpRequest(application, '/wagering/transactions', { ...wager(target.id), playerId: 'another' }, key());
    expect(result).toMatchObject({ status: 422, body: { failureCode: FailureCode.WalletMismatch } });
    expect(persistence.transactions.size).toBe(1); expect(persistence.ledger).toHaveLength(1);
  });
  test('a missing wallet is a business error with a stable code', async () => {
    const result = await httpRequest(application, '/wagering/transactions', wager('missing'), key());
    expect(result).toMatchObject({ status: 422, body: { failureCode: 'WALLET_NOT_FOUND' } }); expect(persistence.transactions.size).toBe(0);
  });
  test.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '08006', '55P03', '57014', '40P01', '40001', '57P03', '53300'])(
    'transient %s is 503 without leaking database details', async code => {
      persistence.failure = Object.assign(new Error('secret postgres SQL password'), { code });
      const result = await httpRequest(application, '/wallets', wallet);
      expect(result).toEqual({ status: 503, body: { code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unable to process request' } });
      expect(persistence.wallets.size).toBe(0);
    },
  );
  test.each(['23503', '23505', 'XX000'])('unexpected SQL %s is a sanitized 500 rather than an identity conflict', async code => {
    persistence.failure = Object.assign(new Error('secret table SQL password'), { code });
    expect(await httpRequest(application, '/wallets', wallet)).toEqual({ status: 500, body: { code: 'INTERNAL_ERROR', message: 'Unable to process request' } });
  });
  test('closing the application releases its persistence resource', async () => {
    await application.close(); expect(persistence.closed).toBe(true);
  });

  test.each(['9007199254740993.01', '92233720368547758.07'])('HTTP preserves exact USD amount %s as a string', async amount => {
    const result = await httpRequest(application, '/wallets', { ...wallet, initialBalance: { amount, currency: 'USD' } });
    expect(result).toMatchObject({ status: 201, body: { balance: { amount, currency: 'USD' } } });
  });
  test('an unresolved plain PENDING fixture returns 503 rather than a fictional 202 acceptance', async () => {
    const target = await open(); const input = wager(target.id);
    const pending = new WagerTransactionIdentity().createCandidate({ ...input, kind: Kind.Bet, idempotencyKey: 'key' }, 'fixture', new Date());
    persistence.transactions.set(pending.id, pending);
    expect((await httpRequest(application, '/wagering/transactions', input, key())).status).toBe(503);
    expect(persistence.ledger).toHaveLength(1); expect(persistence.transactions.get(pending.id)!.status).toBe(Status.Pending);
  });
  test('pool acquisition timeout is a sanitized transient 503', async () => {
    persistence.failure = Object.assign(new Error('pool password SQL'), { name: 'KnexTimeoutError' });
    expect((await httpRequest(application, '/wallets', wallet)).status).toBe(503);
  });
  test('exhausted transaction retries are 503 without a financial result', async () => {
    const target = await open(); const before = persistence.calls;
    persistence.failure = new WagerProcessingRetryableError('40001', new Error('private SQL'));
    const result = await httpRequest(application, '/wagering/transactions', wager(target.id), key());
    expect(result).toMatchObject({ status: 503, body: { code: 'SERVICE_UNAVAILABLE' } });
    expect(persistence.calls - before).toBe(3); expect(persistence.transactions.size).toBe(1); expect(persistence.ledger).toHaveLength(1);
  });

});
