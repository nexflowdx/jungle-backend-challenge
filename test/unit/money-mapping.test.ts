import { describe, expect, test } from 'bun:test';
import { MoneyAmountType, rehydrateMoney } from '../../src/database/money-mapping';
import { Money } from '../../src/shared/domain/money';

describe('exact PostgreSQL money mapping (3.1)', () => {
  const type = new MoneyAmountType();
  test('preserves SQL NULL in both conversion directions', () => {
    expect(type.convertToDatabaseValue(null)).toBeNull();
    expect(type.convertToJSValue(null)).toBeNull();
    expect(() => rehydrateMoney(null as unknown as string, 'BRL')).toThrow();
  });
  test.each(['0.00', '0.01', '9007199254740993.01', '92233720368547758.07'])('round-trip %s', amount => {
    const money = Money.from({ amount, currency: 'USD' });
    expect(rehydrateMoney(type.convertToDatabaseValue(money.toString()), money.currency).equals(money)).toBe(true);
  });
  test.each(['0', '12.3', '12.30'])('normalizes PostgreSQL strings %s', value => {
    expect(rehydrateMoney(value, 'BRL').toString()).toBe(value === '0' ? '0.00' : '12.30');
  });
  test.each([undefined, 1, NaN, Infinity, 'NaN', 'Infinity', '-1.00', '1e2', '1.001', '1.230', ''])('rejects unsafe hydration %s', value => {
    expect(() => type.convertToJSValue(value as string)).toThrow();
  });
  test.each([undefined, 1, NaN, Infinity, 'NaN', 'Infinity', '1e2', '', '1', '1.0', '1.001', '1.230', '-0.01'])('rejects unsafe writes %s', value => {
    expect(() => type.convertToDatabaseValue(value as string)).toThrow();
  });
  test('declares NUMERIC without typmod and delegates Money invariants to domain', () => {
    expect(type.getColumnType()).toBe('numeric');
    expect(type.compareAsType()).toBe('string');
    expect(() => rehydrateMoney('92233720368547758.08', 'BRL')).toThrow();
    expect(() => rehydrateMoney('1.00', 'EUR')).toThrow();
  });
});
