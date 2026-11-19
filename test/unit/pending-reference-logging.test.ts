import { expect, test } from 'bun:test';
import { ProcessPendingReference } from '../../src/modules/wagering/application/process-pending-reference';
import type { WagerProcessingTransaction, WagerProcessingUnitOfWork } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { Money } from '../../src/shared/domain/money';
import { JsonLogger } from '../../src/modules/operations/json-logger';
import { runWithLogContext } from '../../src/modules/operations/log-context';

function fixture(failCommit = false) {
  const at = new Date('2026-11-17T12:00:00Z');
  const wallet = Wallet.open({ id: 'wallet', playerId: 'player', at, initialBalance: Money.zero('BRL') });
  const transaction = WagerTransaction.create({ id: 'transaction', providerId: 'provider', externalTransactionId: 'external',
    idempotencyKey: 'key', payloadHash: 'hash', walletId: 'wallet', playerId: 'player', roundId: 'round', gameId: 'game',
    kind: Kind.Win, money: Money.from({ amount: '1.00', currency: 'BRL' }), referenceExternalTransactionId: 'missing', createdAt: at });
  transaction.markPendingReference(wallet.balance);
  let committed = false; let events: unknown;
  const scope = { lockWallet: async () => wallet, loadTransaction: async () => transaction,
    loadPendingReferenceSchedule: async () => ({ attempts: 0, nextAttemptAt: null, deadlineAt: null }),
    loadPendingReferenceContext: async () => ({ correlationId: 'original-correlation', causationId: 'CAUSATION_SECRET' }),
    findReference: async () => undefined, findProcessedReversals: async () => [], completePendingReference: async () => {},
    schedulePendingReference: async () => {}, insertEvents: async (values: unknown) => { events = values; },
  } as unknown as WagerProcessingTransaction;
  const work: WagerProcessingUnitOfWork = { transaction: async callback => {
    const result = await callback(scope); if (failCommit) throw new Error('commit failed'); committed = true; return result;
  } };
  return { work, wallet, transaction, committed: () => committed, events: () => events };
}
test('pending reference completion logs original correlation only after commit, without causation or inherited message IDs', async () => {
  const f = fixture(); const lines: string[] = [];
  const processor = new ProcessPendingReference(f.work, () => new Date('2026-11-19T12:00:00Z'), () => 'event', new JsonLogger(line => {
    expect(f.committed()).toBe(true); lines.push(line);
  }));
  expect(await runWithLogContext({ correlationId: 'unrelated', messageId: 'wrong-envelope' }, () => processor.execute({ id: 'transaction', walletId: 'wallet' }))).toBe('expired');
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(lines).toHaveLength(1); expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'pending_reference.completed',
    correlationId: 'original-correlation', transactionId: 'transaction', walletId: 'wallet', providerId: 'provider' });
  expect(lines[0]!).not.toContain('SECRET'); expect(lines[0]!).not.toContain('messageId'); expect(lines[0]!).not.toContain('unrelated');
  expect(f.transaction.status).toBe(Status.Failed); expect(f.wallet.balance.toString()).toBe('0.00'); expect(f.events()).toBeDefined();
});
test('failed commit never emits a successful pending reference completion', async () => {
  const f = fixture(true); const lines: string[] = [];
  const processor = new ProcessPendingReference(f.work, () => new Date('2026-11-19T12:00:00Z'), () => 'event', new JsonLogger(line => lines.push(line)));
  await expect(processor.execute({ id: 'transaction', walletId: 'wallet' })).rejects.toThrow('commit failed');
  await new Promise<void>(resolve => setImmediate(resolve)); expect(lines).toEqual([]); expect(f.committed()).toBe(false);
});
