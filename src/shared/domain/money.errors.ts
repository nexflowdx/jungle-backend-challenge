import { DomainError } from './domain-error';

export class InvalidMoneyAmountError extends DomainError {
  constructor() {
    super('INVALID_MONEY_AMOUNT', 'Amount must be a non-negative decimal string with exactly two fractional digits');
  }
}

export class InvalidCurrencyError extends DomainError {
  constructor() {
    super('INVALID_CURRENCY', 'Currency must be a supported ISO-4217 code: BRL or USD');
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor() {
    super('CURRENCY_MISMATCH', 'Money operations require the same currency');
  }
}

export class AmountLimitExceededError extends DomainError {
  constructor() {
    super('AMOUNT_LIMIT_EXCEEDED', 'Money magnitude must not exceed 92233720368547758.07');
  }
}
