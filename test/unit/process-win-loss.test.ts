import { describe, expect, test } from 'bun:test';
import { walletMapper, transactionMapper } from '../../src/database/domain-mappers';
import { Money } from '../../src/shared/domain/money';
import type { IntegrationEvent } from '../../src/shared/domain/integration-event';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import type { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { ProcessWagerTransaction, WagerProcessingNotImplementedError, type SupportedWagerCommand } from '../../src/modules/wagering/application/process-wager-transaction';
import { WagerTransactionIdentity } from '../../src/modules/wagering/application/wager-transaction-identity';
import { WagerProcessingRetryableError, WagerProcessingUnitOfWork, type WagerProcessingTransaction } from '../../src/modules/wagering/application/wager-processing-unit-of-work';

const at = new Date('2026-11-17T12:00:00.000Z');
const command = (kind: Kind.Win | Kind.Loss, overrides: Partial<SupportedWagerCommand> = {}): SupportedWagerCommand => ({
  kind, walletId: 'wallet', playerId: 'player', providerId: 'provider', externalTransactionId: 'external',
  idempotencyKey: 'key', gameId: 'game', roundId: 'round', money: { amount: '25.00', currency: 'BRL' }, correlationId: 'correlation', ...overrides,
});

// Records application orchestration with the real domain. PostgreSQL tests prove database rollback.
class WinLossWork extends WagerProcessingUnitOfWork {
  wallet = Wallet.open({ id: 'wallet', playerId: 'player', at, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    opening: { id: 'opening', transactionId: 'opening-tx' } });
  rows = new Map<string, WagerTransaction>();
  ledger: WalletLedgerEntry[] = [];
  events: IntegrationEvent<unknown>[] = [];
  calls: string[] = [];
  failAt: string | undefined;
  retries = 0;
  override async transaction<T>(callback: (scope: WagerProcessingTransaction) => Promise<T>): Promise<T> {
    this.calls.push('begin');
    const wallet = walletMapper.toDomain(walletMapper.toRecord(this.wallet));
    const rows = new Map([...this.rows].map(([id, tx]) => [id, transactionMapper.toDomain(transactionMapper.toRecord(tx))]));
    const ledger = [...this.ledger]; const events = [...this.events];
    const step = (name: string) => { this.calls.push(name); if (this.failAt === name) throw new Error('injected failure'); };
    const result = await callback({
      lockWallet: async () => { step('lock'); return wallet; },
      findIdentityCandidates: async key => [...rows.values()].filter(tx => tx.idempotencyKey === key.idempotencyKey
        || (tx.providerId === key.providerId && tx.externalTransactionId === key.externalTransactionId)),
      insertPending: async tx => { step('pending'); rows.set(tx.id, transactionMapper.toDomain(transactionMapper.toRecord(tx))); },
      findReference: async () => { throw new Error('Unreferenced operations must not load references'); },
      findProcessedReversals: async () => { throw new Error('Existing operations must not query reversals'); },
      loadTransaction: async id => rows.get(id),
      saveWallet: async () => { step('wallet'); },
      completeTransaction: async tx => { step('result'); rows.set(tx.id, transactionMapper.toDomain(transactionMapper.toRecord(tx))); },
      insertLedgerEntry: async entry => { step('ledger'); ledger.push(entry); },
      insertEvents: async newEvents => { step('outbox'); events.push(...newEvents); },
    });
    if (this.retries-- > 0) throw new WagerProcessingRetryableError('40001', new Error('serialization failure'));
    this.wallet = wallet; this.rows = rows; this.ledger = ledger; this.events = events; this.calls.push('commit');
    return result;
  }
}
function processor(work: WinLossWork) {
  let id = 0;
  return new ProcessWagerTransaction(work, new WagerTransactionIdentity(), { newId: () => `id-${++id}`, now: () => at, retryDelay: async () => {} });
}

describe('WIN and LOSS application (5.4)', () => {
  test('WIN credits through the domain and persists one CREDIT and both events', async () => {
    const work = new WinLossWork();
    const result = await processor(work).execute(command(Kind.Win));
    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: '125.00', currency: 'BRL' }, idempotentReplay: false });
    expect(work.wallet.version).toBe(2);
    expect(work.ledger).toHaveLength(1);
    expect(work.ledger[0]).toMatchObject({ direction: 'CREDIT', walletVersion: 2 });
    expect(work.ledger[0]!.isBalanced()).toBe(true);
    expect(work.events.map(event => event.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });
  test.each(['0.00', '25.00'])('LOSS %s completes without changing balance, version, ledger or updatedAt', async amount => {
    const work = new WinLossWork(); const before = work.wallet.updatedAt;
    const result = await processor(work).execute(command(Kind.Loss, { money: { amount, currency: 'BRL' } }));
    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: '100.00' } });
    expect(work.wallet.version).toBe(1); expect(work.wallet.updatedAt).toEqual(before);
    expect(work.ledger).toHaveLength(0);
    expect(work.calls).not.toContain('wallet'); expect(work.calls).not.toContain('ledger');
    expect(work.events.map(event => event.eventType)).toEqual(['WagerTransactionProcessed']);
  });
  test.each([Kind.Win, Kind.Loss])('%s replay returns its original snapshot after a BET', async kind => {
    const work = new WinLossWork(); const useCase = processor(work); const input = command(kind);
    const first = await useCase.execute(input);
    await useCase.execute({ ...input, kind: Kind.Bet, idempotencyKey: 'bet', externalTransactionId: 'bet', money: { amount: '10.00', currency: 'BRL' } });
    const events = work.events.length; const entries = work.ledger.length;
    expect(await useCase.execute(input)).toEqual({ ...first, idempotentReplay: true });
    expect(work.events).toHaveLength(events); expect(work.ledger).toHaveLength(entries);
  });
  test.each([Kind.Win, Kind.Loss])('%s rejects a mismatching currency through the domain without movement', async kind => {
    const work = new WinLossWork();
    expect(await processor(work).execute(command(kind, { money: { amount: '1.00', currency: 'USD' } })))
      .toMatchObject({ status: Status.Rejected, failureCode: FailureCode.CurrencyMismatch, balance: { currency: 'BRL', amount: '100.00' } });
    expect(work.wallet.version).toBe(1); expect(work.ledger).toHaveLength(0);
    expect(work.events.map(event => event.eventType)).toEqual(['WagerTransactionRejected']);
  });
  test('WIN overflow is rejected with the maximum balance unchanged', async () => {
    const work = new WinLossWork();
    work.wallet = Wallet.open({ id: 'wallet', playerId: 'player', at, initialBalance: Money.from({ amount: '92233720368547758.07', currency: 'BRL' }),
      opening: { id: 'opening', transactionId: 'opening-tx' } });
    const result = await processor(work).execute(command(Kind.Win, { money: { amount: '0.01', currency: 'BRL' } }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.AmountLimitExceeded, balance: { amount: '92233720368547758.07' } });
    expect(work.wallet.version).toBe(1); expect(work.ledger).toHaveLength(0);
  });
  test.each([Kind.Bet, Kind.Loss])('%s reference stays unavailable before persistence', async kind => {
    const work = new WinLossWork();
    await expect(processor(work).execute({ ...command(Kind.Win, { referenceExternalTransactionId: 'reference' }), kind })).rejects.toBeInstanceOf(WagerProcessingNotImplementedError);
    expect(work.calls).toHaveLength(0);
  });
  test.each([Kind.Win, Kind.Loss])('%s rejects changed payload or kind under the same key', async kind => {
    const work = new WinLossWork(); const useCase = processor(work); const input = command(kind);
    await useCase.execute(input); const before = work.wallet.balance.toString();
    await expect(useCase.execute({ ...input, money: { amount: '26.00', currency: 'BRL' } })).rejects.toMatchObject({ code: 'WAGER_IDENTITY_CONFLICT' });
    await expect(useCase.execute({ ...input, kind: kind === Kind.Win ? Kind.Loss : Kind.Win })).rejects.toMatchObject({ code: 'WAGER_IDENTITY_CONFLICT' });
    expect(work.wallet.balance.toString()).toBe(before);
  });
  test.each([Kind.Win, Kind.Loss])('%s serialization retry commits once', async kind => {
    const work = new WinLossWork(); work.retries = 1;
    await processor(work).execute(command(kind));
    expect(work.calls.filter(call => call === 'begin')).toHaveLength(2);
    expect(work.ledger).toHaveLength(kind === Kind.Win ? 1 : 0);
    expect(work.events).toHaveLength(kind === Kind.Win ? 2 : 1);
    expect(work.wallet.balance.toString()).toBe(kind === Kind.Win ? '125.00' : '100.00');
  });
  test.each([Kind.Win, Kind.Loss])('%s propagates outbox failure without returning success', async kind => {
    const work = new WinLossWork(); work.failAt = 'outbox';
    await expect(processor(work).execute(command(kind))).rejects.toThrow('injected failure');
    expect(work.calls).not.toContain('commit');
  });
  test.each([
    [Kind.Win, '0.00'], [Kind.Win, '-1.00'], [Kind.Loss, '-1.00'], [Kind.Win, '1.001'], [Kind.Loss, '1.001'],
  ] as const)('%s invalid amount %s fails before persistence', async (kind, amount) => {
    const work = new WinLossWork();
    await expect(processor(work).execute(command(kind, { money: { amount, currency: 'BRL' } }))).rejects.toThrow();
    expect(work.calls).toHaveLength(0);
  });
});
