import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { IntegrationEvent } from '../../src/shared/domain/integration-event';
import type { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';
import { OpenWallet, type OpeningRuntime } from '../../src/modules/wallets/application/open-wallet';
import { WalletAlreadyExistsError, WalletOpeningUnitOfWork, type WalletOpeningTransaction } from '../../src/modules/wallets/application/wallet-opening-unit-of-work';
import type { Wallet } from '../../src/modules/wallets/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import { WalletsModule } from '../../src/modules/wallets/wallets.module';

const at = new Date('2026-11-17T12:00:00.000Z');
const command = (amount = '100.00', currency = 'BRL') => ({
  playerId: 'player', initialBalance: { amount, currency }, correlationId: 'correlation', causationId: 'request',
});
function runtime(): OpeningRuntime {
  let sequence = 0;
  return { newId: () => `id-${++sequence}`, now: () => at };
}

// Records orchestration only. PostgreSQL tests verify actual rollback and constraints.
class RecordingOpeningUnitOfWork extends WalletOpeningUnitOfWork {
  readonly calls: string[] = [];
  wallet: Wallet | undefined;
  opening: WagerTransaction | undefined;
  entry: WalletLedgerEntry | undefined;
  events: readonly IntegrationEvent<unknown>[] = [];
  beforeCommit: () => Promise<void> = async () => {};

  override async transaction<T>(work: (transaction: WalletOpeningTransaction) => Promise<T>): Promise<T> {
    this.calls.push('begin');
    const result = await work({
      insertWallet: async wallet => { this.wallet = wallet; this.calls.push('wallet'); },
      insertOpening: async opening => { this.opening = opening; this.calls.push('opening'); },
      insertLedgerEntry: async entry => { this.entry = entry; this.calls.push('ledger'); },
      insertEvents: async events => { this.events = events; this.calls.push('outbox'); },
    });
    await this.beforeCommit();
    this.calls.push('commit');
    return result;
  }
}

describe('OpenWallet orchestration (4.1–4.3)', () => {
  test.each(['BRL', 'USD'])('opens zero %s at version one without financial artifacts', async currency => {
    const work = new RecordingOpeningUnitOfWork();
    const result = await new OpenWallet(work, runtime()).execute(command('0.00', currency));
    expect(result).toEqual({ id: 'id-1', playerId: 'player', balance: { amount: '0.00', currency }, version: 1 });
    expect(work.wallet!.pendingLedgerEntries).toHaveLength(0);
    expect(work.opening).toBeUndefined();
    expect(work.entry).toBeUndefined();
    expect(work.events).toHaveLength(0);
    expect(work.calls).toEqual(['begin', 'wallet', 'commit']);
  });

  test.each([
    ['0.01', 'BRL'], ['100.00', 'BRL'], ['9007199254740993.01', 'BRL'], ['92233720368547758.07', 'BRL'],
    ['0.01', 'USD'], ['100.00', 'USD'], ['9007199254740993.01', 'USD'], ['92233720368547758.07', 'USD'],
  ])('opens exact %s %s using the domain opening, credit and two events', async (amount, currency) => {
    const work = new RecordingOpeningUnitOfWork();
    const result = await new OpenWallet(work, runtime()).execute(command(amount!, currency!));
    const { wallet, opening, entry, events } = work;
    expect(result.balance).toEqual({ amount, currency });
    expect(result.version).toBe(1);
    expect(opening!.kind).toBe(Kind.Opening);
    expect(opening!.status).toBe(Status.Processed);
    expect(opening!.money.equals(wallet!.balance)).toBe(true);
    expect(opening!.balance!.equals(wallet!.balance)).toBe(true);
    expect(opening!.completedAt).toEqual(at);
    expect(opening!.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(opening!.providerId).toBe('internal:wallet-opening');
    expect(entry!.transactionId).toBe(opening!.id);
    expect(entry!.walletId).toBe(wallet!.id);
    expect(entry!.direction).toBe(LedgerDirection.Credit);
    expect(entry!.balanceBefore.isZero()).toBe(true);
    expect(entry!.balanceAfter.equals(wallet!.balance)).toBe(true);
    expect(entry!.walletVersion).toBe(1);
    expect(entry!.isBalanced()).toBe(true);
    expect(events.map(event => event.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(new Set(events.map(event => event.eventId)).size).toBe(2);
    for (const event of events) {
      expect(event.toJSON()).toMatchObject({ aggregateId: wallet!.id, correlationId: 'correlation', causationId: 'request',
        occurredAt: at.toISOString(), version: 1, data: { walletId: wallet!.id, transactionId: opening!.id, money: { amount, currency } } });
      expect(() => JSON.stringify(event.toJSON())).not.toThrow();
    }
    expect(work.calls).toEqual(['begin', 'wallet', 'opening', 'ledger', 'outbox', 'commit']);
  });

  test.each(['-0.01', '1', '1.0', '1.001', 'NaN', 'Infinity', '1e2', '92233720368547758.08'])('rejects invalid money %s before starting persistence', async amount => {
    const work = new RecordingOpeningUnitOfWork();
    await expect(new OpenWallet(work).execute(command(amount))).rejects.toThrow();
    expect(work.calls).toEqual([]);
  });

  test.each([
    { playerId: '' }, { correlationId: '' }, { causationId: '' },
    { initialBalance: { amount: '1.00', currency: 'EUR' } },
    { initialBalance: { amount: 1 as unknown as string, currency: 'BRL' } },
  ])('rejects invalid input %j before starting persistence', async invalid => {
    const work = new RecordingOpeningUnitOfWork();
    await expect(new OpenWallet(work).execute({ ...command(), ...invalid })).rejects.toThrow();
    expect(work.calls).toEqual([]);
  });

  test('waits for commit before resolving and returns an immutable snapshot', async () => {
    const work = new RecordingOpeningUnitOfWork();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void;
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    work.beforeCommit = async () => { arrived(); await barrier; };
    let resolved = false;
    const opening = new OpenWallet(work).execute(command()).then(result => { resolved = true; return result; });
    await ready;
    expect(resolved).toBe(false);
    expect(work.calls).not.toContain('commit');
    release();
    const result = await opening;
    expect(resolved).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.balance)).toBe(true);
  });

  test.each([new WalletAlreadyExistsError(), new Error('commit failed')])('propagates persistence or commit failure without returning success: %s', async error => {
    const work = new RecordingOpeningUnitOfWork();
    work.beforeCommit = async () => { throw error; };
    await expect(new OpenWallet(work).execute(command())).rejects.toBe(error);
    expect(work.calls).not.toContain('commit');
  });

  test('omits absent causation from event envelopes and uses fresh default identities', async () => {
    const work = new RecordingOpeningUnitOfWork();
    const result = await new OpenWallet(work).execute({ playerId: 'player', initialBalance: { amount: '1.00', currency: 'BRL' }, correlationId: 'correlation' });
    expect(result.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(work.wallet!.createdAt.getTime()).toBeGreaterThan(0);
    expect(new Set([result.id, work.opening!.id, work.entry!.id, ...work.events.map(event => event.eventId)]).size).toBe(5);
    for (const event of work.events) expect(event.toJSON()).not.toHaveProperty('causationId');
  });

  test('registers a usable Nest provider without a database or HTTP listener', async () => {
    const work = new RecordingOpeningUnitOfWork();
    const application = await NestFactory.createApplicationContext(WalletsModule.register(work), { logger: false, abortOnError: false });
    try {
      const result = await application.get(OpenWallet).execute(command('0.00'));
      expect(result.version).toBe(1);
      expect(work.calls).toEqual(['begin', 'wallet', 'commit']);
    } finally { await application.close(); }
  });
});
