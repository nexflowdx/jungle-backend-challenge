import 'reflect-metadata';
import { afterEach, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createHttpApplication } from '../../src/http/http-api.module';
import type { WalletLedgerAccess } from '../../src/http/wallet-ledger-access.guard';
import type { ReconciliationSummary, WalletReconciliationSource } from '../../src/modules/wallets/application/reconcile-wallet';
import { HttpMemoryPersistence } from '../helpers/http-memory-persistence';
import { httpRequest } from '../helpers/http-request';

let application: INestApplication | undefined;
afterEach(async () => { await application?.close(); application = undefined; });
const allowed: WalletLedgerAccess = { canRead: (_, id) => id === 'allowed' || id === 'missing' };
const summary: ReconciliationSummary = { initialBalance: '100.00', credits: '0.02', debits: '0.01',
  calculatedBalance: '100.01', difference: '0.00', checkedEntries: 3, issues: [] };
async function start(options: { access?: WalletLedgerAccess; summary?: Partial<ReconciliationSummary>; failure?: Error; missingAdapter?: boolean } = {}) {
  let reads = 0; const persistence = new HttpMemoryPersistence();
  const walletReconciliation: WalletReconciliationSource = { snapshot: async work => {
    reads++;
    if (options.failure) throw options.failure;
    return work({ wallet: async id => id === 'missing' ? undefined : { id, balance: { amount: '100.01', currency: 'BRL' }, version: 3 },
      summarize: async () => ({ ...summary, ...options.summary }) });
  } };
  application = await createHttpApplication({ ...persistence, ...(options.missingAdapter ? {} : { walletReconciliation }) }, { logger: false }, options.access);
  await application.init();
  return { reads: () => reads, writes: () => persistence.calls };
}
const post = (id = 'allowed', headers: [string, string][] = [], body?: unknown) => httpRequest(application!, `/wallets/${id}/reconciliation`, body, headers);
test.each(['allowed', 'missing'])('default policy blocks %s before any lookup despite client auth/ownership headers', async id => {
  const state = await start();
  expect((await post(id, [['Authorization', 'Bearer fake'], ['X-Wallet-Id', id], ['X-Player-Id', 'owner']])).status).toBe(403);
  expect(state.reads()).toBe(0); expect(state.writes()).toBe(0);
});
test('authorized reconciliation returns the existing service contract, ignoring client financial overrides', async () => {
  const state = await start({ access: allowed });
  expect(await post('allowed', [], { walletId: 'other', calculatedBalance: '0.00', consistent: true })).toEqual({ status: 200, body: {
    walletId: 'allowed', currency: 'BRL', storedBalance: { amount: '100.01', currency: 'BRL' },
    initialBalance: { amount: '100.00', currency: 'BRL' }, credits: { amount: '0.02', currency: 'BRL' }, debits: { amount: '0.01', currency: 'BRL' },
    calculatedBalance: { amount: '100.01', currency: 'BRL' }, difference: { amount: '0.00', currency: 'BRL' },
    checkedEntries: 3, status: 'CONSISTENT', consistent: true, issues: [],
  } });
  expect(state.reads()).toBe(1); expect(state.writes()).toBe(0);
});
test('permission for one wallet cannot access another wallet', async () => {
  const state = await start({ access: allowed });
  expect((await post('other')).status).toBe(403); expect(state.reads()).toBe(0);
});
test('missing wallet returns 404 only after authorization', async () => {
  const state = await start({ access: allowed });
  expect(await post('missing')).toEqual({ status: 404, body: { code: 'WALLET_NOT_FOUND', message: 'Wallet not found' } });
  expect(state.reads()).toBe(1); expect(state.writes()).toBe(0);
});
test('financial divergence is a successful read with false consistency and signed difference', async () => {
  await start({ access: allowed, summary: { calculatedBalance: '100.02', difference: '-0.01' } });
  expect(await post()).toMatchObject({ status: 200, body: { status: 'DIVERGENT', consistent: false, difference: { amount: '-0.01' } } });
});
test('inconclusive result never reports true consistency or invented calculated values', async () => {
  await start({ access: allowed, summary: { initialBalance: null, calculatedBalance: null, difference: null, issues: ['INITIAL_BALANCE_UNPROVEN'] } });
  expect(await post()).toMatchObject({ status: 200, body: { status: 'INCONCLUSIVE', consistent: null,
    initialBalance: null, calculatedBalance: null, difference: null, issues: ['INITIAL_BALANCE_UNPROVEN'] } });
});
test.each(['ECONNREFUSED', '40001', '57P01'])('transient infrastructure %s returns sanitized 503', async code => {
  const state = await start({ access: allowed, failure: Object.assign(new Error('password=secret SELECT financial_payload'), { code }) });
  expect(await post()).toEqual({ status: 503, body: { code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unable to process request' } });
  expect(state.writes()).toBe(0);
});
test('unexpected failure returns sanitized 500', async () => {
  await start({ access: allowed, failure: new Error('token=secret postgres://credentials SELECT balance') });
  expect(await post()).toEqual({ status: 500, body: { code: 'INTERNAL_ERROR', message: 'Unable to process request' } });
});
test('authorized legacy composition without reconciliation adapter returns 503', async () => {
  const state = await start({ access: allowed, missingAdapter: true });
  expect((await post()).status).toBe(503); expect(state.reads()).toBe(0);
});
