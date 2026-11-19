import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { createPersistence } from '../../src/database/orm';
import { WalletRecord, WagerTransactionRecord, LedgerEntryRecord, OutboxMessageRecord } from '../../src/database/entities';
import { createHttpApplication } from '../../src/http/http-api.module';
import { PostgresWalletOpeningUnitOfWork } from '../../src/modules/wallets/infrastructure/postgres-wallet-opening-unit-of-work';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { assertPersistenceTestEnvironment } from './environment';
import { httpRequest } from '../helpers/http-request';
import { JsonLogger } from '../../src/modules/operations/json-logger';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
type WalletResponse = { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
type TransactionResponse = { transactionId: string; status: string; balance: { amount: string; currency: string }; idempotentReplay: boolean; failureCode?: string };
describe.skipIf(!enabled)('HTTP with real PostgreSQL and real NestJS providers (5.8)', () => {
  let orm: MikroORM; let application: INestApplication;
  const fresh = () => orm.em.fork();
  const key = (value = randomUUID()): [string, string][] => [['Idempotency-Key', value]];
  async function open(amount = '100.00', currency = 'BRL') {
    const result = await httpRequest(application, '/wallets', { playerId: randomUUID(), initialBalance: { amount, currency } });
    expect(result.status).toBe(201); return result.body as WalletResponse;
  }
  const command = (target: WalletResponse, kind = 'BET', amount = '25.00') => ({ providerId: 'provider', externalTransactionId: randomUUID(),
    walletId: target.id, playerId: target.playerId, roundId: 'round', gameId: 'game', kind, money: { amount, currency: target.balance.currency } });
  async function snapshot(target: WalletResponse) {
    const manager = fresh();
    return {
      wallet: { ...await manager.findOneOrFail(WalletRecord, target.id) },
      transactions: (await manager.find(WagerTransactionRecord, { walletId: target.id }, { orderBy: { id: 'asc' } })).map(row => ({ ...row })),
      ledger: (await manager.find(LedgerEntryRecord, { walletId: target.id }, { orderBy: { id: 'asc' } })).map(row => ({ ...row })),
      outbox: (await manager.find(OutboxMessageRecord, { aggregateId: target.id }, { orderBy: { id: 'asc' } })).map(row => ({ ...row })),
    };
  }
  beforeAll(async () => {
    assertPersistenceTestEnvironment(process.env);
    orm = await createPersistence({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test', user: 'diagnostic', password: process.env.PGPASSWORD! });
    await orm.getMigrator().up();
    application = await createHttpApplication({ walletOpening: new PostgresWalletOpeningUnitOfWork(orm), wagerProcessing: new PostgresWagerProcessingUnitOfWork(orm) }, { logger: false });
    await application.init();
  }, 30000);
  afterAll(async () => { if (application) await application.close(); if (orm) await orm.close(true); });

  test('HTTP correlation persists in outbox and changes on replay without new financial effects when logging rejects', async () => {
    const app = await createHttpApplication({ walletOpening: new PostgresWalletOpeningUnitOfWork(orm), wagerProcessing: new PostgresWagerProcessingUnitOfWork(orm) },
      { logger: false }, undefined, new JsonLogger(() => Promise.reject(new Error('LOG_SECRET'))));
    await app.init();
    try {
      const wallet = await open(); const input = command(wallet); const headers = key(); let responseCorrelation: unknown;
      const first = await httpRequest(app, '/wagering/transactions', input, [...headers, ['X-Correlation-Id', 'correlation-first']], undefined, 'POST', values => { responseCorrelation = values['x-correlation-id']; });
      expect(first.status).toBe(200); expect(responseCorrelation).toBe('correlation-first');
      const before = await snapshot(wallet); const transactionId = (first.body as TransactionResponse).transactionId;
      const events = before.outbox.filter(row => (row.payload.data as { transactionId: string }).transactionId === transactionId);
      expect(events).toHaveLength(2); expect(events.every(row => row.payload.correlationId === 'correlation-first')).toBe(true);
      const replay = await httpRequest(app, '/wagering/transactions', input, [...headers, ['X-Correlation-Id', 'correlation-replay']], undefined, 'POST', values => { responseCorrelation = values['x-correlation-id']; });
      expect(responseCorrelation).toBe('correlation-replay'); expect(replay).toEqual({ status: 200, body: { ...first.body as object, idempotentReplay: true } });
      expect(await snapshot(wallet)).toEqual(before);
    } finally { await app.close(); }
  });

  test('wallet HTTP creates zero/positive openings and maps the actual duplicate constraint to 409', async () => {
    const zero = await open('0.00'); const positive = await open('9007199254740993.01', 'USD');
    expect(zero.version).toBe(1); expect(positive.balance.amount).toBe('9007199254740993.01');
    expect(await fresh().count(LedgerEntryRecord, { walletId: zero.id })).toBe(0);
    expect(await fresh().count(LedgerEntryRecord, { walletId: positive.id })).toBe(1);
    expect((await httpRequest(application, '/wallets', { playerId: positive.playerId, initialBalance: positive.balance })).status).toBe(409);
    expect((await fresh().findOneOrFail(WalletRecord, positive.id)).version).toBe(1);
  });
  test('HTTP BET, WIN and LOSS preserve processed history and identity conflicts in real SQL', async () => {
    const target = await open(); const input = command(target); const headers = key();
    const first = await httpRequest(application, '/wagering/transactions', input, headers);
    expect(first).toMatchObject({ status: 200, body: { status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } } });
    expect((await httpRequest(application, '/wagering/transactions', command(target, 'WIN', '10.00'), key())).status).toBe(200);
    const beforeLoss = (await fresh().findOneOrFail(WalletRecord, target.id)).version;
    expect((await httpRequest(application, '/wagering/transactions', command(target, 'LOSS', '0.00'), key())).status).toBe(200);
    expect((await fresh().findOneOrFail(WalletRecord, target.id)).version).toBe(beforeLoss);
    const before = await snapshot(target);
    expect(await httpRequest(application, '/wagering/transactions', input, [...headers, ['X-Correlation-Id', 'retry']]))
      .toEqual({ status: 200, body: { ...first.body as object, idempotentReplay: true } });
    expect((await httpRequest(application, '/wagering/transactions', { ...input, money: { amount: '26.00', currency: 'BRL' } }, headers)).status).toBe(409);
    expect((await httpRequest(application, '/wagering/transactions', input, key())).status).toBe(409);
    expect(await snapshot(target)).toEqual(before);
  });
  test('HTTP rejection is durable with no financial movement, and invalid DTO never writes', async () => {
    const target = await open(); const input = command(target, 'BET', '101.00'); const headers = key(); const before = await snapshot(target);
    expect((await httpRequest(application, '/wagering/transactions', { ...input, money: { amount: 101, currency: 'BRL' } }, headers)).status).toBe(400);
    expect(await snapshot(target)).toEqual(before);
    const first = await httpRequest(application, '/wagering/transactions', input, headers);
    expect(first).toMatchObject({ status: 422, body: { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: target.balance } });
    const after = await snapshot(target); expect(after.wallet).toEqual(before.wallet); expect(after.ledger).toEqual(before.ledger);
    expect(after.transactions).toHaveLength(before.transactions.length + 1); expect(after.outbox).toHaveLength(before.outbox.length + 1);
    expect(await httpRequest(application, '/wagering/transactions', input, headers)).toEqual({ status: 422, body: { ...first.body as object, idempotentReplay: true } });
    expect(await snapshot(target)).toEqual(after);
  });
  test('HTTP pending reference returns the persisted acceptance and stays pending after arrival', async () => {
    const target = await open(); const bet = command(target); const input = { ...command(target, 'WIN'), referenceExternalTransactionId: bet.externalTransactionId }; const headers = key();
    const before = await snapshot(target); const first = await httpRequest(application, '/wagering/transactions', input, headers);
    expect(first).toMatchObject({ status: 202, body: { status: 'PENDING_REFERENCE', balance: target.balance, idempotentReplay: false } });
    const after = await snapshot(target); expect(after.wallet).toEqual(before.wallet); expect(after.ledger).toEqual(before.ledger);
    const id = (first.body as TransactionResponse).transactionId;
    expect(await fresh().findOneOrFail(WagerTransactionRecord, id)).toMatchObject({ acceptedBalance: '100.00', balance: null, completedAt: null });
    expect((await httpRequest(application, '/wagering/transactions', bet, key())).status).toBe(200); const arrived = await snapshot(target);
    expect(await httpRequest(application, '/wagering/transactions', input, headers)).toEqual({ status: 202, body: { ...first.body as object, idempotentReplay: true } });
    expect(await snapshot(target)).toEqual(arrived);
  });
  test('HTTP REFUND and ROLLBACK retain the documented per-type policy and immutable ledger', async () => {
    const target = await open(); const bet = command(target); await httpRequest(application, '/wagering/transactions', bet, key());
    for (const kind of ['REFUND', 'ROLLBACK']) {
      const input = { ...command(target, kind), referenceExternalTransactionId: bet.externalTransactionId }; const headers = key();
      const result = await httpRequest(application, '/wagering/transactions', input, headers);
      expect(result.status).toBe(200); const tx = result.body as TransactionResponse;
      expect(await fresh().findOneOrFail(LedgerEntryRecord, { transactionId: tx.transactionId })).toMatchObject({ direction: 'CREDIT', amount: '25.00' });
      const before = await snapshot(target);
      expect(await httpRequest(application, '/wagering/transactions', input, headers)).toEqual({ status: 200, body: { ...tx, idempotentReplay: true } });
      expect(await snapshot(target)).toEqual(before);
    }
    expect(await fresh().findOneOrFail(WalletRecord, target.id)).toMatchObject({ balance: '125.00', version: 4 });
  });
});
