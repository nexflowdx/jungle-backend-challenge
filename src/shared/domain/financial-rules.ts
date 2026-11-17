import { DomainError } from './domain-error';

export function assertIdentifier(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError('INVALID_IDENTIFIER', 'An identifier must be a non-empty string');
  }
}

export function timestamp(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError('INVALID_TIMESTAMP', 'A valid date is required');
  }
  return value.getTime();
}

export function assertVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError('INVALID_WALLET_VERSION', 'Wallet version must be a positive safe integer');
  }
}
