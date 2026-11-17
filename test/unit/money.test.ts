import { describe, expect, test } from 'bun:test';
import { DomainError } from '../../src/shared/domain/domain-error';
import { Money, type MoneyProps } from '../../src/shared/domain/money';
import {
  AmountLimitExceededError, CurrencyMismatchError, InvalidCurrencyError, InvalidMoneyAmountError,
} from '../../src/shared/domain/money.errors';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const maximum = '92233720368547758.07';

describe('Money parsing and serialization', () => {
  test.each(['0.00', '0.01', '0.10', '1.00', '25.00', '9007199254740993.01', maximum])(
    'preserves %s exactly through decimal and JSON round-trips', (amount) => {
      const money = brl(amount);
      expect(money.toString()).toBe(amount);
      expect(money.toJSON()).toEqual({ amount, currency: 'BRL' });
      expect(JSON.stringify(money)).toBe(JSON.stringify({ amount, currency: 'BRL' }));
      const parsed = JSON.parse(JSON.stringify(money)) as MoneyProps;
      expect(Money.from(parsed).equals(money)).toBe(true);
    },
  );

  test('normalizes leading zeros without losing cents', () => {
    expect(brl('000025.01').toString()).toBe('25.01');
    expect(brl('0000.00').toString()).toBe('0.00');
    expect(brl(`0000${maximum}`).toString()).toBe(maximum);
  });

  test.each([
    '', ' ', '1', '1.0', '1.001', '1.230', '.01', '1.', '1,00', '1_000.00',
    '1,000.00', 'NaN', 'Infinity', '-Infinity', '1e2', '1e2.00', '0x10.00',
    '-1.00', '-0.00', '+1.00', ' 1.00', '1.00 ', '1.00\n', '1.00\r\n',
    '\t1.00', '1.00\u0000', '１.００', '1.00extra',
  ])('rejects invalid external amount %j', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyAmountError);
  });

  test.each([0, 1.23, NaN, Infinity, 1n, null, undefined, {}, [], true].map((amount) => [amount] as const))(
    'rejects non-string amount at runtime: %s', (amount) => {
      expect(() => Money.from({ amount, currency: 'BRL' } as MoneyProps)).toThrow(InvalidMoneyAmountError);
    },
  );

  test.each([null, undefined, [], '1.00', {}].map((props) => [props] as const))('rejects malformed props: %s', (props) => {
    expect(() => Money.from(props as MoneyProps)).toThrow(InvalidMoneyAmountError);
  });

  test.each(['92233720368547758.08', '99999999999999999.99', '100000000000000000.00'])(
    'rejects amount above the approved magnitude: %s', (amount) => {
      expect(() => brl(amount)).toThrow(AmountLimitExceededError);
    },
  );

  test('rejects very large amounts before converting to bigint', () => {
    expect(() => brl(`${'9'.repeat(10_000)}.00`)).toThrow(AmountLimitExceededError);
  });

  test.each(['BRL', 'USD'])('supports %s and its exact zero', (currency) => {
    const zero = Money.zero(currency);
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency });
    expect(Money.from({ amount: '25.00', currency }).currency).toBe(currency);
  });

  test.each(['', 'brl', 'usd', ' BRL', 'BRL ', 'EUR', 'ZZZ', '123', '__proto__', 'toString', null, undefined, 123])(
    'rejects unsupported or malformed currency: %j', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency } as MoneyProps)).toThrow(InvalidCurrencyError);
      expect(() => Money.zero(currency as string)).toThrow(InvalidCurrencyError);
    },
  );

  test('does not retain a reference to mutable input or serialized props', () => {
    const props = { amount: '25.00', currency: 'BRL' };
    const money = Money.from(props);
    props.amount = '99.00';
    props.currency = 'USD';
    const serialized = { ...money.toJSON() };
    serialized.amount = '12.00';
    serialized.currency = 'USD';
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(money.toJSON()).not.toBe(money.toJSON());
  });
});

describe('Money immutable operations', () => {
  test.each([
    ['0.10', '0.20', '0.30'], ['0.99', '0.01', '1.00'],
    ['9007199254740993.01', '0.09', '9007199254740993.10'],
    ['92233720368547758.06', '0.01', maximum],
  ])('adds %s and %s exactly', (left, right, expected) => {
    expect(brl(left).add(brl(right)).toString()).toBe(expected);
  });

  test.each([
    ['1.00', '0.01', '0.99'], ['0.30', '0.20', '0.10'],
    ['0.00', '0.01', '-0.01'], ['0.01', '1.00', '-0.99'],
    ['9007199254740993.01', '0.01', '9007199254740993.00'],
    [maximum, maximum, '0.00'], ['0.00', maximum, `-${maximum}`],
  ])('subtracts %s minus %s exactly', (left, right, expected) => {
    expect(brl(left).subtract(brl(right)).toString()).toBe(expected);
  });

  test('handles signed intermediate results with correct arithmetic and serialization', () => {
    const negative = brl('1.20').negate();
    expect(negative.add(brl('0.10')).toString()).toBe('-1.10');
    expect(negative.subtract(brl('0.80')).toString()).toBe('-2.00');
    expect(negative.add(brl('2.00')).toString()).toBe('0.80');
    expect(negative.add(brl('0.80').negate()).toString()).toBe('-2.00');
    expect(negative.subtract(brl('0.80').negate()).toString()).toBe('-0.40');
    expect(negative.negate().equals(brl('1.20'))).toBe(true);
    expect(negative.toJSON()).toEqual({ amount: '-1.20', currency: 'BRL' });
    expect(brl(maximum).negate().negate().toString()).toBe(maximum);
    expect(() => Money.from(negative.toJSON())).toThrow(InvalidMoneyAmountError);
  });

  test('keeps zero unsigned, including after negation and cancellation', () => {
    const zero = Money.zero('BRL');
    expect(zero.negate().toString()).toBe('0.00');
    expect(brl('1.00').add(brl('1.00').negate()).toString()).toBe('0.00');
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  test('compares exact amounts and signed results', () => {
    const negative = brl('0.01').negate();
    const zero = Money.zero('BRL');
    const positive = brl('0.01');
    expect(negative.isNegative()).toBe(true);
    expect(negative.isPositive()).toBe(false);
    expect(negative.isZero()).toBe(false);
    expect(positive.isPositive()).toBe(true);
    expect(positive.isNegative()).toBe(false);
    expect(positive.isZero()).toBe(false);
    expect(negative.isLessThan(zero)).toBe(true);
    expect(zero.isLessThan(positive)).toBe(true);
    expect(positive.isLessThan(negative)).toBe(false);
    expect(positive.isLessThan(brl('0.01'))).toBe(false);
    expect(positive.equals(brl('0.01'))).toBe(true);
    expect(positive.equals(negative)).toBe(false);
    expect(positive.equals(zero)).toBe(false);
    expect(brl('9007199254740993.01').equals(brl('9007199254740993.02'))).toBe(false);
    expect(brl('9007199254740993.01').isLessThan(brl('9007199254740993.02'))).toBe(true);
  });

  test.each(['add', 'subtract', 'isLessThan', 'equals'] as const)(
    'rejects currency mismatch in %s in both directions', (operation) => {
      const left = brl('1.00');
      const right = Money.from({ amount: '1.00', currency: 'USD' });
      expect(() => left[operation](right)).toThrow(CurrencyMismatchError);
      expect(() => right[operation](left)).toThrow(CurrencyMismatchError);
      expect(() => Money.zero('BRL')[operation](Money.zero('USD'))).toThrow(CurrencyMismatchError);
    },
  );

  test('supports operations in USD as well as BRL', () => {
    const money = Money.from({ amount: '1.25', currency: 'USD' });
    expect(money.add(money).toJSON()).toEqual({ amount: '2.50', currency: 'USD' });
    expect(money.subtract(money).equals(Money.zero('USD'))).toBe(true);
    expect(money.negate().currency).toBe('USD');
  });

  test('returns new instances without modifying either operand', () => {
    const left = brl('1.00');
    const right = brl('0.10');
    const results = [left.add(right), left.subtract(right), left.negate(), left.add(Money.zero('BRL'))];
    for (const result of results) {
      expect(result).not.toBe(left);
      expect(result).not.toBe(right);
      expect(Object.isFrozen(result)).toBe(true);
    }
    expect(left.toString()).toBe('1.00');
    expect(right.toString()).toBe('0.10');
    expect(Object.isFrozen(left)).toBe(true);
    expect(Reflect.set(left, 'currency', 'USD')).toBe(false);
    expect(left.currency).toBe('BRL');
    const zero = Money.zero('BRL');
    expect(zero.negate()).not.toBe(zero);
  });

  test('rejects overflow and underflow without changing operands', () => {
    const max = brl(maximum);
    const min = max.negate();
    const cent = brl('0.01');
    expect(() => max.add(cent)).toThrow(AmountLimitExceededError);
    expect(() => min.subtract(cent)).toThrow(AmountLimitExceededError);
    expect(() => max.subtract(cent.negate())).toThrow(AmountLimitExceededError);
    expect(() => min.add(cent.negate())).toThrow(AmountLimitExceededError);
    expect(() => max.add(max)).toThrow(AmountLimitExceededError);
    expect(() => min.add(min)).toThrow(AmountLimitExceededError);
    expect(() => max.subtract(min)).toThrow(AmountLimitExceededError);
    expect(() => min.subtract(max)).toThrow(AmountLimitExceededError);
    expect(max.toString()).toBe(maximum);
    expect(min.toString()).toBe(`-${maximum}`);
    expect(cent.toString()).toBe('0.01');
  });

  test('preserves inverse arithmetic over a deterministic range of exact amounts', () => {
    // The oracle is a decimal string generated from bigint, independent of Money parsing.
    for (let cents = 0n; cents <= 10_000n; cents += 37n) {
      const amount = `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
      const money = brl(amount);
      const increment = brl('12.34');
      expect(money.add(increment).subtract(increment).toString()).toBe(amount);
      expect(money.subtract(increment).add(increment).toString()).toBe(amount);
      expect(money.negate().negate().toString()).toBe(amount);
      expect(money.add(money.negate()).isZero()).toBe(true);
    }
  });

  test('exposes stable domain errors without infrastructure dependencies', () => {
    for (const [error, code] of [
      [new InvalidMoneyAmountError(), 'INVALID_MONEY_AMOUNT'],
      [new InvalidCurrencyError(), 'INVALID_CURRENCY'],
      [new CurrencyMismatchError(), 'CURRENCY_MISMATCH'],
      [new AmountLimitExceededError(), 'AMOUNT_LIMIT_EXCEEDED'],
    ] as const) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error.code).toBe(code);
      expect(error.name).toBe(error.constructor.name);
    }
  });
});
