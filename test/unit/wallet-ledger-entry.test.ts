import { describe, expect, test } from 'bun:test';
import { LedgerDirection as Direction, WalletLedgerEntry, type LedgerEntryState } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import { at, money } from './financial-fixtures';

function props(overrides: Partial<LedgerEntryState> = {}): LedgerEntryState {
  return {
    id: 'entry', walletId: 'wallet', transactionId: 'transaction', direction: Direction.Debit,
    money: money('0.01'), balanceBefore: money('1.00'), balanceAfter: money('0.99'), walletVersion: 2, createdAt: at,
    ...overrides,
  };
}

describe('WalletLedgerEntry (2.2)', () => {
  test.each([
    [Direction.Debit, '1.00', '1.00', '0.00'],
    [Direction.Credit, '0.01', '0.00', '0.01'],
    [Direction.Credit, '0.01', '9007199254740993.00', '9007199254740993.01'],
    [Direction.Debit, '92233720368547758.07', '92233720368547758.07', '0.00'],
  ] as const)('validates exact %s arithmetic: %s from %s to %s', (direction, amount, before, after) => {
    const entry = WalletLedgerEntry.create(props({ direction, money: money(amount), balanceBefore: money(before), balanceAfter: money(after) }));
    expect(entry.isBalanced()).toBe(true);
  });

  test.each([
    { balanceAfter: money('0.98') }, { direction: Direction.Credit },
    { money: money('0.00') }, { money: money('0.01').negate() },
    { balanceBefore: money('0.01').negate() }, { balanceAfter: money('0.01').negate() },
    { money: money('0.01', 'USD') }, { balanceBefore: money('1.00', 'USD') }, { balanceAfter: money('0.99', 'USD') },
    { direction: 'OTHER' as Direction }, { id: '' }, { transactionId: '' }, { walletId: '' },
    { walletVersion: 0 }, { createdAt: new Date(NaN) },
  ])('rejects inconsistent entries (%j)', (overrides) => {
    expect(() => WalletLedgerEntry.create(props(overrides))).toThrow();
  });

  test('is structurally immutable and defensively copies dates and inputs', () => {
    const createdAt = new Date(at);
    const input = { ...props(), createdAt };
    const entry = WalletLedgerEntry.create(input);
    input.id = 'changed';
    input.money = money('99.00');
    createdAt.setTime(0);
    entry.createdAt.setTime(0);
    expect(entry.id).toBe('entry');
    expect(entry.money.toString()).toBe('0.01');
    expect(entry.createdAt).toEqual(at);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Reflect.set(entry, 'balanceAfter', money('100.00'))).toBe(false);
  });

  test('rehydrates without executing the creation arithmetic validation', () => {
    const state = props({ balanceAfter: money('0.98') });
    const entry = WalletLedgerEntry.rehydrate(state);
    expect(entry.balanceAfter.toString()).toBe('0.98');
    expect(entry.isBalanced()).toBe(false);
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
