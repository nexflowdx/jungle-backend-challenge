import 'reflect-metadata';
import { afterEach, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createHttpApplication } from '../../src/http/http-api.module';
import { JsonLogger, type LogSink } from '../../src/modules/operations/json-logger';
import { currentLogContext } from '../../src/modules/operations/log-context';
import { HttpMemoryPersistence } from '../helpers/http-memory-persistence';
import { httpRequest } from '../helpers/http-request';

let app: INestApplication | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
const opening = { playerId: 'player', initialBalance: { amount: '100.00', currency: 'BRL' } };
async function start(sink: LogSink = () => {}) {
  const persistence = new HttpMemoryPersistence();
  app = await createHttpApplication(persistence, { logger: false }, undefined, new JsonLogger(sink)); await app.init();
  return persistence;
}
async function request(path: string, body: unknown, headers: [string, string][] = [], raw?: string) {
  let correlation: unknown;
  const result = await httpRequest(app!, path, body, headers, raw, 'POST', values => { correlation = values['x-correlation-id']; });
  return { ...result, correlation };
}
test('valid HTTP correlation reaches response, committed events and logs', async () => {
  const lines: string[] = []; const persistence = await start(line => lines.push(line));
  const response = await request('/wallets', opening, [['X-Correlation-Id', 'caller:request-1']]);
  expect(response.status).toBe(201); expect(response.correlation).toBe('caller:request-1');
  expect(persistence.events.every(event => event.correlationId === 'caller:request-1')).toBe(true);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(lines.map(line => JSON.parse(line).correlationId)).toEqual(['caller:request-1', 'caller:request-1']);
  expect(currentLogContext()).toEqual({});
});
test.each([
  [], [['X-Correlation-Id', '']], [['X-Correlation-Id', 'with space']], [['X-Correlation-Id', 'a,b']],
  [['X-Correlation-Id', 'x'.repeat(129)]], [['X-Correlation-Id', 'a'], ['x-correlation-id', 'b']],
].map(headers => ({ headers: headers as [string, string][] })))('missing/invalid/duplicate HTTP correlation %# generates UUID without rejecting request', async ({ headers }) => {
  const persistence = await start(); const response = await request('/wallets', opening, headers);
  expect(response.status).toBe(201); expect(response.correlation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(response.correlation).toBe(persistence.events[0]!.correlationId);
});
test('guard rejection and malformed JSON still return correlation headers', async () => {
  const persistence = await start();
  expect(await request('/wallets/private/reconciliation', undefined, [['X-Correlation-Id', 'denied']])).toMatchObject({ status: 403, correlation: 'denied' });
  expect(await request('/wallets', undefined, [['X-Correlation-Id', 'invalid-json']], '{')).toMatchObject({ status: 400, correlation: 'invalid-json' });
  expect(persistence.calls).toBe(0);
});
test('new correlation on replay does not change hash, identity or financial result even when logger rejects', async () => {
  const persistence = await start(() => Promise.reject(new Error('LOG_SECRET')));
  const wallet = await request('/wallets', opening); const walletId = (wallet.body as { id: string }).id;
  const body = { providerId: 'provider', externalTransactionId: 'external', walletId, playerId: 'player', roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
  const first = await request('/wagering/transactions', body, [['Idempotency-Key', 'key'], ['X-Correlation-Id', 'first']]);
  const tx = [...persistence.transactions.values()].find(value => value.externalTransactionId === 'external')!;
  const hash = tx.payloadHash; const eventCount = persistence.events.length;
  const replay = await request('/wagering/transactions', body, [['Idempotency-Key', 'key'], ['X-Correlation-Id', 'retry']]);
  expect(replay).toMatchObject({ status: first.status, correlation: 'retry', body: { ...first.body as object, idempotentReplay: true } });
  expect(persistence.transactions.get(tx.id)!.payloadHash).toBe(hash); expect(persistence.ledger).toHaveLength(2);
  expect(persistence.events).toHaveLength(eventCount); expect(persistence.wallets.get(walletId)!.balance.toString()).toBe('75.00');
  await new Promise<void>(resolve => setImmediate(resolve));
});
test('concurrent HTTP requests cannot exchange correlation contexts across an explicit barrier', async () => {
  const seen: string[] = []; let arrived = 0; let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const persistence = new HttpMemoryPersistence();
  app = await createHttpApplication({ ...persistence, walletLedger: { read: async () => {
    const initial = currentLogContext().correlationId!; if (++arrived === 2) release(); await barrier;
    expect(currentLogContext().correlationId).toBe(initial); seen.push(initial); return [];
  } } }, { logger: false }, { canRead: () => true }, new JsonLogger(() => {})); await app.init();
  const responses = await Promise.all(['request-a', 'request-b'].map(id => httpRequest(app!, '/wallets/wallet/ledger', undefined, [['X-Correlation-Id', id]], undefined, 'GET')));
  expect(responses.every(response => response.status === 200)).toBe(true); expect(seen.sort()).toEqual(['request-a', 'request-b']);
  expect(currentLogContext()).toEqual({});
});
