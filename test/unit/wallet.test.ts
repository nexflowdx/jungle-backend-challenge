import { describe, expect, test } from 'bun:test';
import { Wallet, type WalletState } from '../../src/modules/wallets/domain/wallet';
import { LedgerDirection } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import { at, later, money, wallet } from './financial-fixtures';

describe('Wallet opening and rehydration (2.1)', () => {
  test.each(['BRL', 'USD'])('opens zero %s at version 1 without a ledger entry', (currency) => {
    const target = wallet('0.00', currency);
    expect(target.balance.toString()).toBe('0.00');
    expect(target.currency).toBe(currency);
    expect(target.version).toBe(1);
    expect(target.pendingLedgerEntries).toEqual([]);
    expect(target.createdAt).toEqual(at);
    expect(target.updatedAt).toEqual(at);
  });

  test.each(['0.01', '100.00', '9007199254740993.01', '92233720368547758.07'])(
    'opens %s with one exact OPENING credit and version 1', (amount) => {
      const target = wallet(amount);
      const [entry] = target.pendingLedgerEntries;
      expect(target.balance.toString()).toBe(amount);
      expect(target.version).toBe(1);
      expect(target.pendingLedgerEntries).toHaveLength(1);
      expect(entry?.transactionId).toBe('opening-transaction');
      expect(entry?.direction).toBe(LedgerDirection.Credit);
      expect(entry?.balanceBefore.toString()).toBe('0.00');
      expect(entry?.balanceAfter.toString()).toBe(amount);
      expect(entry?.walletVersion).toBe(1);
      expect(entry?.isBalanced()).toBe(true);
    },
  );

  test('rejects negative opening and a positive opening without ledger identity', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('0.01').negate(), at })).toThrow();
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('0.01'), at })).toThrow('Positive opening');
  });

  test('rehydrates the snapshot without creating OPENING, incrementing version or replaying rules', () => {
    const target = Wallet.rehydrate({
      id: 'w', playerId: 'p', currency: 'USD', balance: money('9007199254740993.01', 'USD'),
      version: 42, createdAt: at, updatedAt: later,
    });
    expect(target.version).toBe(42);
    expect(target.balance.toString()).toBe('9007199254740993.01');
    expect(target.pendingLedgerEntries).toHaveLength(0);
    expect(target.updatedAt).toEqual(later);
    expect(target.createdAt).toEqual(at);
  });

  test.each([0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid snapshot version %s', (version) => {
    expect(() => Wallet.rehydrate({
      id: 'w', playerId: 'p', currency: 'BRL', balance: money('0.00'), version, createdAt: at, updatedAt: at,
    })).toThrow();
  });

  test('rejects structurally impossible snapshots', () => {
    const state: WalletState = { id: 'w', playerId: 'p', currency: 'BRL', balance: money('0.00'), version: 1, createdAt: at, updatedAt: at };
    expect(() => Wallet.rehydrate({ ...state, balance: money('0.01').negate() })).toThrow();
    expect(() => Wallet.rehydrate({ ...state, balance: money('0.00', 'USD') })).toThrow();
  });

  test('protects identity, dates and the entry collection from external mutation', () => {
    const createdAt = new Date(at);
    const target = Wallet.open({ id: 'w', playerId: 'p', initialBalance: money('0.00'), at: createdAt });
    createdAt.setTime(0);
    target.createdAt.setTime(0);
    target.updatedAt.setTime(0);
    expect(target.createdAt).toEqual(at);
    expect(target.updatedAt).toEqual(at);
    expect(Reflect.set(target, 'id', 'changed')).toBe(false);
    expect(Reflect.set(target, 'currency', 'USD')).toBe(false);
    expect(Object.isFrozen(target.pendingLedgerEntries)).toBe(true);
  });
});

describe('Wallet movements and ledger invariants (2.2)', () => {
  test('reconstructs the final balance from every entry including OPENING', () => {
    const target = wallet('100.00');
    const debit = target.debit({ id: 'debit', transactionId: 'bet', money: money('80.00'), at: later });
    const credit = target.credit({ id: 'credit', transactionId: 'win', money: money('0.01'), at: later });
    expect(debit.balanceAfter.toString()).toBe('20.00');
    expect(credit.balanceAfter.toString()).toBe('20.01');
    let reconstructed = money('0.00');
    for (const entry of target.pendingLedgerEntries) {
      expect(entry.isBalanced()).toBe(true);
      expect(entry.balanceBefore.equals(reconstructed)).toBe(true);
      reconstructed = entry.direction === LedgerDirection.Credit ? reconstructed.add(entry.money) : reconstructed.subtract(entry.money);
      expect(entry.balanceAfter.equals(reconstructed)).toBe(true);
    }
    expect(target.balance.equals(reconstructed)).toBe(true);
    expect(target.version).toBe(3);
    expect(target.updatedAt).toEqual(later);
    expect(target.pendingLedgerEntries.map((entry) => entry.walletVersion)).toEqual([1, 2, 3]);
  });

  test('permits an exact debit to zero, then rejects another debit without side effects', () => {
    const target = wallet('0.01');
    target.debit({ id: 'entry', transactionId: 'bet', money: money('0.01'), at: later });
    expect(target.balance.isZero()).toBe(true);
    expect(() => target.debit({ id: 'other', transactionId: 'other', money: money('0.01'), at: later })).toThrow('insufficient');
    expect(target.balance.isZero()).toBe(true);
    expect(target.version).toBe(2);
    expect(target.pendingLedgerEntries).toHaveLength(2);
  });

  test.each(['credit', 'debit'] as const)('%s rejects zero, negative and wrong currency without mutation', (operation) => {
    const target = wallet();
    for (const amount of [money('0.00'), money('0.01').negate(), money('1.00', 'USD')]) {
      expect(() => target[operation]({ id: 'entry', transactionId: 'tx', money: amount, at: later })).toThrow();
      expect(target.balance.toString()).toBe('100.00');
      expect(target.version).toBe(1);
      expect(target.pendingLedgerEntries).toHaveLength(1);
      expect(target.updatedAt).toEqual(at);
    }
  });

  test.each([
    { id: '', transactionId: 'tx', at: later },
    { id: 'entry', transactionId: '', at: later },
    { id: 'entry', transactionId: 'tx', at: new Date(NaN) },
  ])('invalid ledger metadata leaves the aggregate unchanged (%j)', (metadata) => {
    const target = wallet();
    expect(() => target.debit({ ...metadata, money: money('1.00') })).toThrow();
    expect(target.balance.toString()).toBe('100.00');
    expect(target.version).toBe(1);
    expect(target.pendingLedgerEntries).toHaveLength(1);
    expect(target.updatedAt).toEqual(at);
  });

  test('credit reaches the exact maximum and overflow preserves all state', () => {
    const target = wallet('92233720368547758.06');
    target.credit({ id: 'last', transactionId: 'last', money: money('0.01'), at: later });
    expect(target.balance.toString()).toBe('92233720368547758.07');
    expect(() => target.credit({ id: 'overflow', transactionId: 'overflow', money: money('0.01'), at })).toThrow();
    expect(target.balance.toString()).toBe('92233720368547758.07');
    expect(target.version).toBe(2);
    expect(target.updatedAt).toEqual(later);
    expect(target.pendingLedgerEntries).toHaveLength(2);
  });

  test('rejects version overflow before modifying the balance', () => {
    const target = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: money('1.00'), version: Number.MAX_SAFE_INTEGER, createdAt: at, updatedAt: at });
    expect(() => target.credit({ id: 'entry', transactionId: 'tx', money: money('0.01'), at: later })).toThrow();
    expect(target.balance.toString()).toBe('1.00');
    expect(target.pendingLedgerEntries).toHaveLength(0);
  });

  test('rejects repeated ledger or transaction identity among new aggregate movements', () => {
    const target = wallet();
    target.debit({ id: 'entry', transactionId: 'tx', money: money('1.00'), at: later });
    for (const identity of [{ id: 'entry', transactionId: 'another' }, { id: 'another', transactionId: 'tx' }]) {
      expect(() => target.credit({ ...identity, money: money('1.00'), at: later })).toThrow();
      expect(target.balance.toString()).toBe('99.00');
      expect(target.version).toBe(2);
      expect(target.pendingLedgerEntries).toHaveLength(2);
    }
  });

  test('maintains financial invariants over a deterministic sequence with an independent bigint oracle', () => {
    const target = wallet('10.00');
    let expectedCents = 1_000n;
    let movementCount = 0;
    const decimal = (cents: bigint): string => `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
    for (let index = 1n; index <= 200n; index++) {
      const cents = (index * 37n) % 1_000n + 1n;
      const debit = index % 3n !== 0n;
      const input = { id: `entry-${index}`, transactionId: `tx-${index}`, money: money(decimal(cents)), at: later };
      if (debit && cents > expectedCents) {
        expect(() => target.debit(input)).toThrow();
      } else {
        const entry = debit ? target.debit(input) : target.credit(input);
        expectedCents = debit ? expectedCents - cents : expectedCents + cents;
        movementCount++;
        expect(entry.balanceAfter.toString()).toBe(decimal(expectedCents));
        expect(entry.isBalanced()).toBe(true);
      }
      expect(target.balance.toString()).toBe(decimal(expectedCents));
      expect(target.balance.isNegative()).toBe(false);
      expect(target.version).toBe(movementCount + 1);
      expect(target.pendingLedgerEntries).toHaveLength(movementCount + 1);
    }
  });
});
