import { expect, test } from 'bun:test';
import { JsonLogger } from '../../src/modules/operations/json-logger';
import { ReconcileWallet, ReconciliationWalletNotFoundError, type ReconciliationSummary, type WalletReconciliationSnapshot } from '../../src/modules/wallets/application/reconcile-wallet';

const wallet = { id: 'wallet', balance: { amount: '100.01', currency: 'BRL' }, version: 3 };
const summary: ReconciliationSummary = {
  initialBalance: '100.00', credits: '0.02', debits: '0.01', calculatedBalance: '100.01', difference: '0.00', checkedEntries: 3, issues: [],
};
test('divergence has a sanitized event after the read transaction resolves, with no financial payload', async () => {
  const lines: string[] = []; let committed = false;
  const service = new ReconcileWallet({ snapshot: async work => {
    const report = await work({ wallet: async () => wallet,
      summarize: async () => ({ ...summary, difference: '-0.01' }) }); committed = true; return report;
  } }, new JsonLogger(line => { if (committed) lines.push(line); }));
  expect((await service.execute('wallet')).status).toBe('DIVERGENT');
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(lines).toHaveLength(1); expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'reconciliation.divergent', walletId: 'wallet', level: 'error' });
  expect(lines[0]!).not.toContain('100.01'); expect(lines[0]!).not.toContain('difference');
});
function query(overrides: Partial<ReconciliationSummary> = {}, currency = 'BRL') {
  const calls: string[] = [];
  const snapshot: WalletReconciliationSnapshot = {
    wallet: async id => { calls.push(`wallet:${id}`); return { ...wallet, balance: { ...wallet.balance, currency } }; },
    summarize: async target => { expect(target.id).toBe(wallet.id); calls.push('summary'); return { ...summary, ...overrides }; },
  };
  return { calls, service: new ReconcileWallet({ snapshot: async work => { calls.push('snapshot'); return work(snapshot); } }) };
}
test('reports exact opening, later credits and debits within one snapshot', async () => {
  const { service, calls } = query();
  expect(await service.execute('wallet')).toEqual({ walletId: 'wallet', currency: 'BRL', storedBalance: wallet.balance,
    initialBalance: { amount: '100.00', currency: 'BRL' }, credits: { amount: '0.02', currency: 'BRL' }, debits: { amount: '0.01', currency: 'BRL' },
    calculatedBalance: { amount: '100.01', currency: 'BRL' }, difference: { amount: '0.00', currency: 'BRL' },
    checkedEntries: 3, consistent: true, status: 'CONSISTENT', issues: [] });
  expect(calls).toEqual(['snapshot', 'wallet:wallet', 'summary']);
});
test.each(['0.01', '-0.01'])('reports signed financial divergence %s separately from infrastructure errors', async difference => {
  const result = await query({ difference }).service.execute('wallet');
  expect(result.status).toBe('DIVERGENT'); expect(result.consistent).toBe(false); expect(result.difference?.amount).toBe(difference);
});
test('unproven initial balance stays inconclusive with null calculated values', async () => {
  const result = await query({ initialBalance: null, calculatedBalance: null, difference: null, issues: ['INITIAL_BALANCE_UNPROVEN'] }).service.execute('wallet');
  expect(result).toMatchObject({ status: 'INCONCLUSIVE', consistent: null, initialBalance: null, calculatedBalance: null, difference: null });
});
test('ledger anomalies prevent a false consistent result even with zero difference', async () => {
  const result = await query({ issues: ['INVALID_LEDGER_SEQUENCE'] }).service.execute('wallet');
  expect(result.status).toBe('INCONCLUSIVE'); expect(result.consistent).toBeNull();
});
test('aggregate turnover can exceed individual Money bounds without truncation', async () => {
  const result = await query({ credits: '100000000000000000.01', debits: '100000000000000000.00' }, 'USD').service.execute('wallet');
  expect(result.credits).toEqual({ amount: '100000000000000000.01', currency: 'USD' });
  expect(result.debits?.amount).toBe('100000000000000000.00'); expect(result.currency).toBe('USD');
});
test('missing wallet is a distinct error, not a divergence', async () => {
  let summarized = false;
  const service = new ReconcileWallet({ snapshot: work => work({ wallet: async () => undefined, summarize: async () => { summarized = true; return summary; } }) });
  await expect(service.execute('missing')).rejects.toBeInstanceOf(ReconciliationWalletNotFoundError);
  expect(summarized).toBe(false);
});
test.each(['begin', 'wallet', 'summary'])('infrastructure failure at %s propagates without producing a financial report', async phase => {
  const failure = new Error('connection unavailable');
  const service = new ReconcileWallet({ snapshot: async work => {
    if (phase === 'begin') throw failure;
    return work({ wallet: async () => { if (phase === 'wallet') throw failure; return wallet; },
      summarize: async () => { throw failure; } });
  } });
  await expect(service.execute('wallet')).rejects.toBe(failure);
});
test('invalid wallet identity never opens a snapshot', async () => {
  let called = false;
  const service = new ReconcileWallet({ snapshot: async () => { called = true; throw new Error(); } });
  expect(() => service.execute(' ')).toThrow(); expect(called).toBe(false);
});
