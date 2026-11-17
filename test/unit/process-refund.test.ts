import { describe, expect, test } from 'bun:test';
import { walletMapper, transactionMapper } from '../../src/database/domain-mappers';
import { Money } from '../../src/shared/domain/money';
import type { IntegrationEvent } from '../../src/shared/domain/integration-event';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import type { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { ProcessWagerTransaction, WagerProcessingNotImplementedError, WagerResultUnavailableError, type SupportedWagerCommand } from '../../src/modules/wagering/application/process-wager-transaction';
import { WagerIdentityCollisionError, WagerTransactionIdentity } from '../../src/modules/wagering/application/wager-transaction-identity';
import { WagerProcessingRetryableError, WagerProcessingUnitOfWork, type WagerProcessingTransaction } from '../../src/modules/wagering/application/wager-processing-unit-of-work';

const at = new Date('2026-11-17T12:00:00.000Z');
let sequence = 0;
const command = (kind: SupportedWagerCommand['kind'], overrides: Partial<SupportedWagerCommand> = {}): SupportedWagerCommand => ({
  ...(kind === Kind.Refund ? { referenceExternalTransactionId: 'reference' } : {}), kind, walletId: 'wallet', playerId: 'player', providerId: 'provider', externalTransactionId: `external-${++sequence}`,
  idempotencyKey: `key-${sequence}`, gameId: 'game', roundId: 'round', money: { amount: '25.00', currency: 'BRL' }, correlationId: 'correlation', ...overrides,
});

// Records application orchestration with the real domain. PostgreSQL tests prove database rollback.
class ReversalWork extends WagerProcessingUnitOfWork {
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
      findReference: async (provider, external) => { step('reference'); return [...rows.values()].find(tx => tx.providerId === provider && tx.externalTransactionId === external); },
      findProcessedReversals: async reference => { step('reversals'); return [...rows.values()].filter(tx => tx.status === Status.Processed
        && (tx.kind === Kind.Refund || tx.kind === Kind.Rollback) && tx.referenceTransactionId === reference); },
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
function processor(work: ReversalWork) {
  let id = 0;
  return new ProcessWagerTransaction(work, new WagerTransactionIdentity(), { newId: () => `id-${++id}`, now: () => at, retryDelay: async () => {} });
}

async function setup() {
  const work = new ReversalWork(); const useCase = processor(work); const bet = command(Kind.Bet);
  const reference = await useCase.execute(bet);
  const refund = command(Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId });
  return { work, useCase, bet, reference, refund };
}

describe('REFUND processing (5.6 phase A)', () => {
  test('credits the full BET with exact CREDIT and both events under the wallet lock', async () => {
    const { work, useCase, refund, reference } = await setup();
    const result = await useCase.execute(refund);
    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: '100.00', currency: 'BRL' } });
    expect(work.wallet.version).toBe(3);
    expect(work.rows.get(result.transactionId)!.referenceTransactionId).toBe(reference.transactionId);
    expect(work.ledger.at(-1)).toMatchObject({ direction: 'CREDIT', walletVersion: 3 });
    expect(work.ledger.at(-1)!.isBalanced()).toBe(true);
    expect(work.events.slice(-2).map(event => event.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(work.calls.indexOf('lock')).toBeLessThan(work.calls.indexOf('reversals'));
  });
  test('same refund replays its original snapshot after a later BET', async () => {
    const { work, useCase, refund } = await setup(); const first = await useCase.execute(refund);
    await useCase.execute(command(Kind.Bet)); const events = work.events.length; const entries = work.ledger.length;
    work.failAt = 'reversals';
    expect(await useCase.execute(refund)).toEqual({ ...first, idempotentReplay: true });
    expect(work.events).toHaveLength(events); expect(work.ledger).toHaveLength(entries); expect(work.wallet.balance.toString()).toBe('75.00');
  });
  test('a distinct second refund is rejected and does not credit again', async () => {
    const { work, useCase, refund } = await setup(); await useCase.execute(refund);
    const second = command(Kind.Refund, { referenceExternalTransactionId: refund.referenceExternalTransactionId! });
    const rejected = await useCase.execute(second);
    expect(rejected).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.AlreadyReversed });
    expect(work.wallet.balance.toString()).toBe('100.00'); expect(work.wallet.version).toBe(3); expect(work.ledger).toHaveLength(2);
    expect(work.events.at(-1)!.eventType).toBe('WagerTransactionRejected');
    expect(await useCase.execute(second)).toEqual({ ...rejected, idempotentReplay: true });
  });
  test.each(['24.99', '25.01'])('rejects non-integral refund %s without consuming the valid reversal', async amount => {
    const { work, useCase, refund } = await setup();
    expect(await useCase.execute({ ...refund, money: { amount, currency: 'BRL' } }))
      .toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceAmountMismatch });
    expect((await useCase.execute(command(Kind.Refund, { referenceExternalTransactionId: refund.referenceExternalTransactionId! }))).status).toBe(Status.Processed);
    expect(work.wallet.balance.toString()).toBe('100.00');
  });
  test('absent reference persists pending acceptance and replay without movement', async () => {
    const work = new ReversalWork(); const useCase = processor(work); const input = command(Kind.Refund);
    const first = await useCase.execute(input);
    expect(first).toMatchObject({ status: Status.PendingReference, balance: { amount: '100.00' } });
    expect(await useCase.execute(input)).toEqual({ ...first, idempotentReplay: true });
    expect(work.wallet.version).toBe(1); expect(work.ledger).toHaveLength(0);
    expect(work.events.map(event => event.eventType)).toEqual(['WagerTransactionPendingReference']);
  });
  test('a non-BET processed reference is rejected', async () => {
    const work = new ReversalWork(); const useCase = processor(work); const win = command(Kind.Win); await useCase.execute(win);
    expect(await useCase.execute(command(Kind.Refund, { referenceExternalTransactionId: win.externalTransactionId })))
      .toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceKindInvalid });
    expect(work.wallet.balance.toString()).toBe('125.00'); expect(work.ledger).toHaveLength(1);
  });
  test.each(['reversals', 'wallet', 'result', 'ledger', 'outbox'])('failure at %s propagates and leaves no refund effect', async point => {
    const { work, useCase, refund } = await setup(); const events = work.events.length; work.failAt = point;
    await expect(useCase.execute(refund)).rejects.toThrow('injected failure');
    expect(work.wallet.balance.toString()).toBe('75.00'); expect(work.wallet.version).toBe(2);
    expect(work.rows.size).toBe(1); expect(work.ledger).toHaveLength(1); expect(work.events).toHaveLength(events);
  });
  test('missing required reference fails before persistence', async () => {
    const work = new ReversalWork(); const { referenceExternalTransactionId: _reference, ...input } = command(Kind.Refund);
    await expect(processor(work).execute(input)).rejects.toMatchObject({ code: 'REFERENCE_REQUIRED' }); expect(work.calls).toHaveLength(0);
  });
  test('changed payload under the same identity conflicts without another credit', async () => {
    const { work, useCase, refund } = await setup(); await useCase.execute(refund);
    await expect(useCase.execute({ ...refund, money: { amount: '30.00', currency: 'BRL' } })).rejects.toMatchObject({ code: 'WAGER_IDENTITY_CONFLICT' });
    expect(work.wallet.balance.toString()).toBe('100.00'); expect(work.ledger).toHaveLength(2);
  });
  test('serialization retry uses fresh reversal state and commits one effect', async () => {
    const { work, useCase, refund } = await setup(); work.retries = 1;
    const result = await useCase.execute(refund);
    expect(result.status).toBe(Status.Processed); expect(work.wallet.balance.toString()).toBe('100.00');
    expect(work.ledger).toHaveLength(2); expect(work.events).toHaveLength(4);
  });

});
