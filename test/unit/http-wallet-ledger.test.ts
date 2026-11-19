import 'reflect-metadata';
import { afterEach, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createHttpApplication } from '../../src/http/http-api.module';
import type { WalletLedgerReader } from '../../src/modules/wallets/application/read-wallet-ledger';
import { HttpMemoryPersistence } from '../helpers/http-memory-persistence';
import { httpRequest } from '../helpers/http-request';

let application: INestApplication | undefined;
afterEach(async () => { await application?.close(); application = undefined; });
const get = (path: string, headers: [string, string][] = []) => httpRequest(application!, path, undefined, headers, undefined, 'GET');
async function start(access?: { canRead: (_: unknown, wallet: string) => boolean }) {
  const persistence = new HttpMemoryPersistence(); let reads = 0;
  const walletLedger: WalletLedgerReader = { read: async wallet => { reads++; return wallet === 'missing' ? undefined : []; } };
  application = await createHttpApplication({ ...persistence, walletLedger }, { logger: false }, access);
  await application.init();
  return { persistence, reads: () => reads };
}
test('ledger defaults to 403 even when client supplies ownership/auth headers; no reads or writes', async () => {
  const state = await start();
  expect((await get('/wallets/wallet/ledger', [['Authorization', 'Bearer fake'], ['X-Player-Id', 'player'], ['X-Wallet-Id', 'wallet']])).status).toBe(403);
  expect(state.reads()).toBe(0); expect(state.persistence.calls).toBe(0);
});
test('trusted wallet access permits only the authorized wallet and retains read-only semantics', async () => {
  const state = await start({ canRead: (_, wallet) => wallet === 'allowed' });
  expect(await get('/wallets/allowed/ledger')).toEqual({ status: 200, body: { items: [], hasNextPage: false, nextCursor: null } });
  expect((await get('/wallets/other/ledger')).status).toBe(403);
  expect(state.reads()).toBe(1); expect(state.persistence.calls).toBe(0);
});
test.each(['limit=0', 'limit=201', 'limit=1.5', 'limit=', 'limit=1&limit=2', 'cursor=invalid', 'cursor=', 'cursor=a&cursor=b'])('HTTP query validation: %s', async query => {
  const state = await start({ canRead: () => true });
  expect((await get(`/wallets/wallet/ledger?${query}`)).status).toBe(400);
  expect(state.reads()).toBe(0); expect(state.persistence.calls).toBe(0);
});
test('authorized lookup of absent wallet returns 404', async () => {
  const state = await start({ canRead: () => true });
  expect(await get('/wallets/missing/ledger')).toEqual({ status: 404, body: { code: 'WALLET_NOT_FOUND', message: 'Wallet not found' } });
  expect(state.reads()).toBe(1);
});
