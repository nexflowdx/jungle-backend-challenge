import { describe, expect, test } from 'bun:test';
import { ProcessPendingReference } from '../../src/modules/wagering/application/process-pending-reference';
import type {
  WagerProcessingTransaction,
  WagerProcessingUnitOfWork,
} from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { Money } from '../../src/shared/domain/money';

import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';

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
      unitOfWork, () => at, () => 'ledger-id',
    ).execute({ id: transaction.id, walletId: wallet.id });

    expect(result).toBe('rescheduled');
    expect(transaction.status).toBe(Status.PendingReference);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(calls).toEqual(['reference', 'schedule']);
    expect(scheduled).toEqual({
      id: 'pending-tx',
      attempts: 1,
      next: new Date('2026-11-18T12:01:00Z'),
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
