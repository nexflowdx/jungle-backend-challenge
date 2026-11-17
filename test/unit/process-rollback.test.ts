import { describe, expect, test } from 'bun:test';
import { walletMapper, transactionMapper } from '../../src/database/domain-mappers';
import { Money } from '../../src/shared/domain/money';
import type { IntegrationEvent } from '../../src/shared/domain/integration-event';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import type { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { ProcessWagerTransaction, WagerProcessingNotImplementedError, WagerResultUnavailableError, type SupportedWagerCommand } from '../../src/modules/wagering/application/process-wager-transaction';
import { WagerIdentityCollisionError, WagerTransactionIdentity } from '../../src/modules/wagering/application/wager-transaction-identity';
import { WagerProcessingRetryableError, WagerProcessingUnitOfWork, type WagerProcessingTransaction } from '../../src/modules/wagering/application/wager-processing-unit-of-work';

const at = new Date('2026-11-17T12:00:00.000Z');
let sequence = 0;
const command = (kind: SupportedWagerCommand['kind'], overrides: Partial<SupportedWagerCommand> = {}): SupportedWagerCommand => ({
  ...((kind === Kind.Refund || kind === Kind.Rollback) ? { referenceExternalTransactionId: 'reference' } : {}), kind, walletId: 'wallet', playerId: 'player', providerId: 'provider', externalTransactionId: `external-${++sequence}`,
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

async function setup(kind: Kind.Bet | Kind.Win | Kind.Refund) {
  const work = new ReversalWork(); const useCase = processor(work);
  let reference = command(kind);
  if (kind === Kind.Refund) {
    const bet = command(Kind.Bet); await useCase.execute(bet);
    reference = command(Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId });
  }
  await useCase.execute(reference);
  const rollback = command(Kind.Rollback, { referenceExternalTransactionId: reference.externalTransactionId });
  return { work, useCase, reference, rollback };
}

describe('ROLLBACK processing (5.6 phase B)', () => {
  test.each([Kind.Bet, Kind.Win, Kind.Refund])('inverts a processed %s with the exact ledger direction', async kind => {
    const { work, useCase, rollback } = await setup(kind); const version = work.wallet.version;
    const result = await useCase.execute(rollback);
    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: kind === Kind.Refund ? '75.00' : '100.00' } });
    expect(work.wallet.version).toBe(version + 1);
    expect(work.ledger.at(-1)!.direction).toBe(kind === Kind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit);
    expect(work.ledger.at(-1)!.isBalanced()).toBe(true);
    expect(work.events.slice(-2).map(event => event.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });
  test.each([Kind.Win, Kind.Refund])('insufficient balance to invert %s rejects without consuming the future reversal', async kind => {
    const { work, useCase, rollback } = await setup(kind);
    await useCase.execute(command(Kind.Bet, { money: work.wallet.balance.toJSON() }));
    const entries = work.ledger.length; const first = await useCase.execute(rollback);
    expect(first).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReversalInsufficientFunds });
    expect(work.ledger).toHaveLength(entries);
    await useCase.execute(command(Kind.Win));
    expect(await useCase.execute(rollback)).toEqual({ ...first, idempotentReplay: true });
    expect((await useCase.execute(command(Kind.Rollback, { referenceExternalTransactionId: rollback.referenceExternalTransactionId! }))).status).toBe(Status.Processed);
    expect(work.wallet.balance.toString()).toBe('0.00');
  });
  test('rejects a distinct second rollback but replays the first without another effect', async () => {
    const { work, useCase, rollback } = await setup(Kind.Bet); const first = await useCase.execute(rollback);
    expect(await useCase.execute(command(Kind.Rollback, { referenceExternalTransactionId: rollback.referenceExternalTransactionId! })))
      .toMatchObject({ status: Status.Rejected, failureCode: FailureCode.AlreadyReversed });
    const entries = work.ledger.length; const events = work.events.length;
    expect(await useCase.execute(rollback)).toEqual({ ...first, idempotentReplay: true });
    expect(work.ledger).toHaveLength(entries); expect(work.events).toHaveLength(events);
  });
  test.each([[Kind.Refund, Kind.Rollback], [Kind.Rollback, Kind.Refund]] as const)('permits %s then %s on the same BET', async (first, second) => {
    const { work, useCase, reference } = await setup(Kind.Bet);
    expect((await useCase.execute(command(first, { referenceExternalTransactionId: reference.externalTransactionId }))).status).toBe(Status.Processed);
    expect((await useCase.execute(command(second, { referenceExternalTransactionId: reference.externalTransactionId }))).status).toBe(Status.Processed);
    expect(work.wallet.balance.toString()).toBe('125.00'); expect(work.wallet.version).toBe(4);
  });
  test('absent reference accepts pending and never emits balance changes', async () => {
    const work = new ReversalWork(); const useCase = processor(work); const input = command(Kind.Rollback);
    const first = await useCase.execute(input);
    expect(first.status).toBe(Status.PendingReference);
    expect(await useCase.execute(input)).toEqual({ ...first, idempotentReplay: true });
    expect(work.ledger).toHaveLength(0); expect(work.wallet.version).toBe(1);
    expect(work.events.map(event => event.eventType)).toEqual(['WagerTransactionPendingReference']);
  });
  test.each(['reversals', 'wallet', 'result', 'ledger', 'outbox'])('debit reversal failure at %s rolls back without a financial result', async point => {
    const { work, useCase, rollback } = await setup(Kind.Win); const entries = work.ledger.length; const events = work.events.length; work.failAt = point;
    await expect(useCase.execute(rollback)).rejects.toThrow('injected failure');
    expect(work.wallet.balance.toString()).toBe('125.00'); expect(work.ledger).toHaveLength(entries); expect(work.events).toHaveLength(events);
  });
  test('missing required reference fails before persistence', async () => {
    const work = new ReversalWork(); const { referenceExternalTransactionId: _reference, ...input } = command(Kind.Rollback);
    await expect(processor(work).execute(input)).rejects.toMatchObject({ code: 'REFERENCE_REQUIRED' }); expect(work.calls).toHaveLength(0);
  });
  test('serialization retry uses fresh reversal state and commits one effect', async () => {
    const { work, useCase, rollback } = await setup(Kind.Win); work.retries = 1;
    const result = await useCase.execute(rollback);
    expect(result.status).toBe(Status.Processed); expect(work.wallet.balance.toString()).toBe('100.00');
    expect(work.ledger).toHaveLength(2); expect(work.events).toHaveLength(4);
  });

});
