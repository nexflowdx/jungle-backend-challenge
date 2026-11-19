import { describe, expect, test } from 'bun:test';
import { InvalidLedgerQueryError, LedgerWalletNotFoundError, ReadWalletLedger, type LedgerHistoryItem, type WalletLedgerReader } from '../../src/modules/wallets/application/read-wallet-ledger';
import { LedgerDirection } from '../../src/modules/wallets/domain/wallet-ledger-entry';

const item: LedgerHistoryItem = {
  id: 'entry', walletId: 'wallet', transactionId: 'transaction', direction: LedgerDirection.Credit,
  money: { amount: '9007199254740993.01', currency: 'BRL' }, balanceBefore: { amount: '0.00', currency: 'BRL' },
  balanceAfter: { amount: '9007199254740993.01', currency: 'BRL' }, walletVersion: 1, createdAt: '2026-11-19T12:34:56.123456Z',
};
const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url');
const cursor = { v: 1, walletId: 'wallet', createdAt: item.createdAt, id: item.id };

describe('ledger read application contract', () => {
  test('fetches limit + 1, serializes exact money and preserves the microsecond cursor', async () => {
    const calls: unknown[][] = [];
    const reader: WalletLedgerReader = { read: async (...args) => { calls.push(args); return [item, { ...item, id: 'older' }]; } };
    const query = new ReadWalletLedger(reader);
    const page = await query.execute('wallet', { limit: '1' });
    expect(calls).toEqual([['wallet', 2, undefined]]);
    expect(page).toEqual({ items: [item], hasNextPage: true, nextCursor: encode(cursor) });
    await query.execute('wallet', { limit: '1', cursor: page.nextCursor });
    expect(calls[1]).toEqual(['wallet', 2, { createdAt: item.createdAt, id: 'entry' }]);
  });
  test('default and maximum limits; final page and empty wallet have no cursor', async () => {
    const limits: number[] = [];
    const query = new ReadWalletLedger({ read: async (_, limit) => { limits.push(limit); return []; } });
    expect(await query.execute('wallet')).toEqual({ items: [], hasNextPage: false, nextCursor: null });
    await query.execute('wallet', { limit: '200' });
    expect(limits).toEqual([51, 201]);
    expect(await new ReadWalletLedger({ read: async () => [item] }).execute('wallet', { limit: '1' }))
      .toEqual({ items: [item], hasNextPage: false, nextCursor: null });
  });
  test('missing wallet is distinct from an empty history', async () => {
    await expect(new ReadWalletLedger({ read: async () => undefined }).execute('missing')).rejects.toBeInstanceOf(LedgerWalletNotFoundError);
  });
  test.each(['0', '-1', '201', '1.5', 'NaN', '1e2', ' 1', '1 ', '01', '', '999999999999999999999', 1, null, ['1'], { value: '1' }].map(limit => ({ limit })))('invalid limit %# never reaches persistence', async ({ limit }) => {
    let called = false;
    const query = new ReadWalletLedger({ read: async () => { called = true; return []; } });
    await expect(query.execute('wallet', { limit })).rejects.toBeInstanceOf(InvalidLedgerQueryError);
    expect(called).toBe(false);
  });
  test.each([
    '', 'not-a-cursor', 'e30=', 'e30!', 'a'.repeat(8193), null, 1, ['e30'], encode(null), encode([]), encode({}),
    encode({ ...cursor, v: 2 }), encode({ ...cursor, walletId: 'other' }), encode({ ...cursor, id: '' }), encode({ ...cursor, id: '\u0000' }),
    encode({ ...cursor, extra: true }), encode({ ...cursor, createdAt: '2026-11-19T12:34:56.123Z' }),
    ...['2026-02-29', '2026-13-01', '2026-00-01', '2026-11-00', '0000-11-19'].map(date => encode({ ...cursor, createdAt: `${date}T12:34:56.123456Z` })),
    ...['24:00:00', '12:60:00', '12:34:60'].map(time => encode({ ...cursor, createdAt: `2026-11-19T${time}.123456Z` })),
  ].map(value => ({ value })))('invalid or cross-wallet cursor %# never reaches persistence', async ({ value }) => {
    let called = false;
    await expect(new ReadWalletLedger({ read: async () => { called = true; return []; } }).execute('wallet', { cursor: value }))
      .rejects.toBeInstanceOf(InvalidLedgerQueryError);
    expect(called).toBe(false);
  });
  test('valid leap day and identifier containing quotes are passed as data', async () => {
    const expected = { createdAt: '2024-02-29T00:00:00.000001Z', id: "entry'" };
    let received: unknown;
    await new ReadWalletLedger({ read: async (_, __, before) => { received = before; return []; } })
      .execute('wallet', { cursor: encode({ v: 1, walletId: 'wallet', ...expected }) });
    expect(received).toEqual(expected);
  });
});
