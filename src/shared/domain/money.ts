import {
  AmountLimitExceededError, CurrencyMismatchError, InvalidCurrencyError, InvalidMoneyAmountError,
} from './money.errors';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

export type Currency = 'BRL' | 'USD';

// Approved symmetric magnitude bound, shared with future persistence checks.
export const MAX_MONEY_MINOR_UNITS = 9_223_372_036_854_775_807n;
const maxMinorUnitDigits = MAX_MONEY_MINOR_UNITS.toString().length;

export class Money {
  readonly #minorUnits: bigint;

  private constructor(minorUnits: bigint, readonly currency: Currency) {
    if (minorUnits > MAX_MONEY_MINOR_UNITS || minorUnits < -MAX_MONEY_MINOR_UNITS) {
      throw new AmountLimitExceededError();
    }
    this.#minorUnits = minorUnits;
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (typeof props !== 'object' || props === null || Array.isArray(props)) {
      throw new InvalidMoneyAmountError();
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string' || amount !== amount.trim() || !/^[0-9]+\.[0-9]{2}$/.test(amount)) {
      throw new InvalidMoneyAmountError();
    }
    Money.assertCurrency(currency);

    // Concatenate validated whole units and cents. Never pass through Number.
    const minorUnits = amount.replace('.', '').replace(/^0+/, '') || '0';
    // Reject oversized input before asking BigInt to allocate a huge integer.
    if (minorUnits.length > maxMinorUnitDigits) throw new AmountLimitExceededError();
    return new Money(BigInt(minorUnits), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#minorUnits + other.#minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.#minorUnits - other.#minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.#minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.#minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.#minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.#minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#minorUnits < other.#minorUnits;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.#minorUnits === other.#minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const magnitude = this.isNegative() ? -this.#minorUnits : this.#minorUnits;
    const whole = magnitude / 100n;
    const cents = (magnitude % 100n).toString().padStart(2, '0');
    return `${this.isNegative() ? '-' : ''}${whole}.${cents}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError();
  }

  private static assertCurrency(currency: string): asserts currency is Currency {
    if (currency !== 'BRL' && currency !== 'USD') throw new InvalidCurrencyError();
  }
}
