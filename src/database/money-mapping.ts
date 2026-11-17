import { Type } from '@mikro-orm/core';
import { Money } from '../shared/domain/money';

// Amount and currency occupy separate columns. No currency is assumed by the ORM type.
export class MoneyAmountType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string {
    if (typeof value !== 'string' || !/^[0-9]+\.[0-9]{2}$/.test(value)) {
      throw new TypeError('Persisted money requires an exact decimal string with two places');
    }
    return value;
  }

  override convertToJSValue(value: string): string {
    if (typeof value !== 'string' || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(value)) {
      throw new TypeError('PostgreSQL NUMERIC must return a non-negative decimal string');
    }
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(2, '0')}`;
  }

  override getColumnType(): string { return 'numeric'; }
  override compareAsType(): string { return 'string'; }
}

export function rehydrateMoney(amount: string, currency: string): Money {
  return Money.from({ amount: new MoneyAmountType().convertToJSValue(amount), currency });
}
