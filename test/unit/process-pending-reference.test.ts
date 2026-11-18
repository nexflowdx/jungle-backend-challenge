import { describe, expect, test } from 'bun:test';
import { ProcessPendingReference } from '../../src/modules/wagering/application/process-pending-reference';
import type {
  WagerProcessingTransaction,
  WagerProcessingUnitOfWork,
} from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { Money } from '../../src/shared/domain/money';

import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { FailureCode, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';

describe('ProcessPendingReference', () => {
  test('reschedules a missing reference without financial effects', async () => {
    const at = new Date('2026-11-18T12:00:00Z');
    const wallet = Wallet.open({
      id: 'wallet', playerId: 'player', at,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      opening: { id: 'opening', transactionId: 'opening-tx' },
    });

    const transaction = WagerTransaction.create({
      id: 'pending-tx',
      providerId: 'provider',
      externalTransactionId: 'external',
      idempotencyKey: 'key',
      payloadHash: 'hash',
      walletId: 'wallet',
      playerId: 'player',
      roundId: 'round',
      gameId: 'game',
      kind: Kind.Win,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'missing-reference',
      createdAt: at,
    });

    transaction.markPendingReference(wallet.balance);

    const calls: string[] = [];
    let scheduled:
      | { id: string; attempts: number; next: Date; deadline: Date }
      | undefined;

    const scope = {
      lockWallet: async () => wallet,
      loadTransaction: async () => transaction,
      loadPendingReferenceSchedule: async () => ({
        attempts: 0,
        nextAttemptAt: null,
        deadlineAt: null,
      }),
      loadPendingReferenceContext: async () => ({ correlationId: 'correlation' }),
      findReference: async () => {
        calls.push('reference');
        return undefined;
      },
      findProcessedReversals: async () => [],
      schedulePendingReference: async (
        id: string, attempts: number, next: Date, deadline: Date,
      ) => {
        calls.push('schedule');
        scheduled = { id, attempts, next, deadline };
      },
      completePendingReference: async () => { calls.push('complete'); },
      saveWallet: async () => { calls.push('wallet'); },
      insertLedgerEntry: async () => { calls.push('ledger'); },
      insertEvents: async () => { calls.push('outbox'); },
    } as unknown as WagerProcessingTransaction;

    const unitOfWork = {
      transaction: async <T>(work: (tx: WagerProcessingTransaction) => Promise<T>) => work(scope),
    } as WagerProcessingUnitOfWork;

    const result = await new ProcessPendingReference(
      unitOfWork, () => new Date(at.getTime() + 3_600_000), () => 'ledger-id',
    ).execute({ id: transaction.id, walletId: wallet.id });

    expect(result).toBe('rescheduled');
    expect(transaction.status).toBe(Status.PendingReference);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(calls).toEqual(['reference', 'schedule']);
    expect(scheduled).toEqual({
      id: 'pending-tx',
      attempts: 1,
      next: new Date('2026-11-18T13:01:00Z'),
      deadline: new Date('2026-11-19T12:00:00Z'),
    });
  });


  test('skips an already finalized transaction without financial effects', async () => {
    const calls: string[] = [];
    const wallet = Wallet.open({
      id: 'wallet',
      playerId: 'player',
      at: new Date('2026-11-18T12:00:00Z'),
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      opening: { id: 'opening', transactionId: 'opening-tx' },
    });

    const scope = {
      lockWallet: async () => {
        calls.push('lock');
        return wallet;
      },
      loadTransaction: async () => {
        calls.push('load');
        return undefined;
      },
      loadPendingReferenceSchedule: async () => undefined,
      loadPendingReferenceContext: async () => ({ correlationId: 'correlation' }),
      completePendingReference: async () => { calls.push('complete'); },
      schedulePendingReference: async () => { calls.push('schedule'); },
      saveWallet: async () => { calls.push('wallet'); },
      insertLedgerEntry: async () => { calls.push('ledger'); },
      insertEvents: async () => { calls.push('outbox'); },
    } as unknown as WagerProcessingTransaction;

    const unitOfWork = {
      transaction: async <T>(work: (transaction: WagerProcessingTransaction) => Promise<T>) => work(scope),
    } as WagerProcessingUnitOfWork;

    const result = await new ProcessPendingReference(unitOfWork).execute({
      id: 'already-finalized',
      walletId: 'wallet',
    });

    expect(result).toBe('skipped');
    expect(calls).toEqual(['lock', 'load']);
    expect(wallet.balance.toString()).toBe('100.00');
  });
});

describe('Pending reference expiration (8.5)', () => {
  const createdAt = new Date('2026-11-18T12:00:00Z');
  const deadlineAt = new Date('2026-11-19T12:00:00Z');

  function setup(offset: number, referenceState: 'missing' | 'processed' | 'rejected' | 'pending' = 'missing') {
    const at = new Date(deadlineAt.getTime() + offset);
    const wallet = Wallet.open({
      id: 'wallet', playerId: 'player', at: createdAt,
      initialBalance: Money.from({ amount: '9007199254740993.01', currency: 'BRL' }),
      opening: { id: 'opening', transactionId: 'opening-tx' },
    });
    const props = {
      providerId: 'provider', walletId: wallet.id, playerId: wallet.playerId,
      roundId: 'round', gameId: 'game', createdAt,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    };
    const transaction = WagerTransaction.create({
      ...props, id: 'win', externalTransactionId: 'win', idempotencyKey: 'win', payloadHash: 'win',
      kind: Kind.Win, referenceExternalTransactionId: 'bet',
    });
    transaction.markPendingReference(wallet.balance);
    const reference = referenceState === 'missing' ? undefined : WagerTransaction.create({
      ...props, id: 'bet', externalTransactionId: 'bet', idempotencyKey: 'bet', payloadHash: 'bet', kind: Kind.Bet,
    });
    if (referenceState === 'processed') reference!.process(wallet, { at, ledgerEntryId: 'bet-ledger', priorReversals: [] });
    if (referenceState === 'rejected') reference!.reject(FailureCode.InsufficientFunds, wallet.balance, at);

    const calls: string[] = [];
    const events: { eventType: string; data: unknown; correlationId: string }[] = [];
    const scheduled: { deadline: Date; next: Date }[] = [];
    const scope = {
      lockWallet: async () => wallet,
      loadTransaction: async () => transaction,
      // Even an old deadline computed from retry time must not extend the TTL.
      loadPendingReferenceSchedule: async () => ({ attempts: 4, nextAttemptAt: new Date(at.getTime() + 60_000), deadlineAt: new Date(at.getTime() + 86_400_000) }),
      loadPendingReferenceContext: async () => ({ correlationId: 'original-correlation' }),
      findReference: async () => { calls.push('reference'); return reference; },
      findProcessedReversals: async () => [],
      schedulePendingReference: async (_id: string, _attempts: number, next: Date, deadline: Date) => { scheduled.push({ next, deadline }); },
      completePendingReference: async () => { calls.push('complete'); },
      saveWallet: async () => { calls.push('wallet'); },
      insertLedgerEntry: async () => { calls.push('ledger'); },
      insertEvents: async (items: typeof events) => { calls.push('outbox'); events.push(...items); },
    } as unknown as WagerProcessingTransaction;
    const unitOfWork: WagerProcessingUnitOfWork = { transaction: callback => callback(scope) };
    const worker = new ProcessPendingReference(unitOfWork, () => at, () => 'event-or-ledger');
    return { worker, scope, transaction, wallet, calls, events, scheduled, at, item: { id: transaction.id, walletId: wallet.id } };
  }

  test.each([0, 1, 3_600_000])('expires at deadline plus %s ms despite a future retry and stale deadline', async offset => {
    const fixture = setup(offset);
    const before = fixture.wallet.balance;
    expect(await fixture.worker.execute(fixture.item)).toBe('expired');
    expect(fixture.transaction.status).toBe(Status.Failed);
    expect(fixture.transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(fixture.transaction.completedAt).toEqual(fixture.at);
    expect(fixture.transaction.balance).toEqual(before);
    expect(fixture.wallet.balance).toEqual(before);
    expect(fixture.wallet.version).toBe(1);
    expect(fixture.wallet.pendingLedgerEntries).toHaveLength(1); // Opening only.
    expect(fixture.calls).toEqual(['reference', 'complete', 'outbox']);
    expect(fixture.events).toMatchObject([{ eventType: 'WagerTransactionFailed', correlationId: 'original-correlation',
      data: { status: Status.Failed, failureCode: FailureCode.ReferenceNotFound, balance: before.toJSON() } }]);
    expect(fixture.scheduled).toHaveLength(0);
    expect(await fixture.worker.execute(fixture.item)).toBe('skipped');
    expect(fixture.events).toHaveLength(1);
  });

  test('propagates an outbox persistence error during expiration as an operational failure', async () => {
    const fixture = setup(0);
    const error = new Error('Outbox unavailable');
    fixture.scope.insertEvents = async () => { throw error; };

    await expect(fixture.worker.execute(fixture.item)).rejects.toBe(error);
    expect(fixture.events).toHaveLength(0);
    expect(fixture.wallet.balance.toString()).toBe('9007199254740993.01');
    expect(fixture.calls).toEqual(['reference', 'complete']);
  });

  test('honors a future retry one millisecond before the deadline', async () => {
    const fixture = setup(-1);
    expect(await fixture.worker.execute(fixture.item)).toBe('skipped');
    expect(fixture.calls).toEqual([]);
    expect(fixture.transaction.status).toBe(Status.PendingReference);
  });

  test('a due retry just before expiration preserves the creation deadline', async () => {
    const fixture = setup(-1);
    fixture.scope.loadPendingReferenceSchedule = async () => ({ attempts: 4, nextAttemptAt: fixture.at, deadlineAt: null });
    expect(await fixture.worker.execute(fixture.item)).toBe('rescheduled');
    expect(fixture.scheduled).toEqual([{ deadline: deadlineAt, next: new Date(fixture.at.getTime() + 960_000) }]);
    expect(fixture.events).toHaveLength(0);
  });

  test.each(['processed', 'rejected', 'pending'] as const)('rechecks a %s reference at expiration using domain rules', async state => {
    const fixture = setup(0, state);
    const outcome = await fixture.worker.execute(fixture.item);
    expect(outcome).toBe(state === 'pending' ? 'expired' : state);
    if (state === 'processed') {
      expect(fixture.transaction.referenceTransactionId).toBe('bet');
      expect(fixture.calls).toEqual(['reference', 'wallet', 'complete', 'ledger', 'outbox']);
      expect(fixture.events.map(event => event.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    } else {
      expect(fixture.transaction.failureCode).toBe(state === 'pending' ? FailureCode.ReferenceNotFound : FailureCode.ReferenceRejected);
      expect(fixture.calls).toEqual(['reference', 'complete', 'outbox']);
    }
  });
});

test('processes an arrived BET reference with one credit and two events', async () => {
  const at = new Date('2026-11-18T12:00:00Z');
  const wallet = Wallet.open({
    id: 'wallet', playerId: 'player', at,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    opening: { id: 'opening', transactionId: 'opening-tx' },
  });

  const create = (id: string, external: string, kind: Kind, amount: string) =>
    WagerTransaction.create({
      id, providerId: 'provider', externalTransactionId: external,
      idempotencyKey: `key-${id}`, payloadHash: `hash-${id}`,
      walletId: 'wallet', playerId: 'player', roundId: 'round', gameId: 'game',
      kind, money: Money.from({ amount, currency: 'BRL' }),
      ...(kind === Kind.Win ? { referenceExternalTransactionId: 'bet-external' } : {}),
      createdAt: at,
    });

  const bet = create('bet-id', 'bet-external', Kind.Bet, '25.00');
  bet.process(wallet, { at, ledgerEntryId: 'bet-ledger', priorReversals: [] });

  const win = create('win-id', 'win-external', Kind.Win, '10.00');
  win.markPendingReference(wallet.balance);

  const calls: string[] = [];
  const events: string[] = [];

  const scope = {
    lockWallet: async () => wallet,
    loadTransaction: async () => win,
    loadPendingReferenceSchedule: async () => ({
      attempts: 0, nextAttemptAt: null, deadlineAt: null,
    }),
    loadPendingReferenceContext: async () => ({ correlationId: 'original-correlation' }),
    findReference: async () => bet,
    findProcessedReversals: async () => [],
    schedulePendingReference: async () => { calls.push('schedule'); },
    saveWallet: async () => { calls.push('wallet'); },
    completePendingReference: async () => { calls.push('complete'); },
    insertLedgerEntry: async () => { calls.push('ledger'); },
    insertEvents: async (items: readonly { eventType: string }[]) => {
      calls.push('outbox');
      events.push(...items.map(item => item.eventType));
    },
  } as unknown as WagerProcessingTransaction;

  const unitOfWork = {
    transaction: async <T>(work: (tx: WagerProcessingTransaction) => Promise<T>) => work(scope),
  } as WagerProcessingUnitOfWork;

  const result = await new ProcessPendingReference(
    unitOfWork, () => at, () => 'win-ledger',
  ).execute({ id: win.id, walletId: wallet.id });

  expect(result).toBe('processed');
  expect(win.status).toBe(Status.Processed);
  expect(wallet.balance.toString()).toBe('85.00');
  expect(calls).toEqual(['wallet', 'complete', 'ledger', 'outbox']);
  expect(events).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
});
