import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogIdentifiers {
  readonly correlationId?: string;
  readonly messageId?: string;
  readonly transactionId?: string;
  readonly walletId?: string;
  readonly providerId?: string;
}
const storage = new AsyncLocalStorage<Readonly<LogIdentifiers>>();
const keys = ['correlationId', 'messageId', 'transactionId', 'walletId', 'providerId'] as const;

/** Copy only primitive, bounded identifiers. No arbitrary object serialization. */
export function logIdentifiers(value: LogIdentifiers): LogIdentifiers {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const id = value[key];
    if (typeof id === 'string' && /^[A-Za-z0-9._:@/-]{1,256}$/.test(id)) result[key] = id;
  }
  return result;
}
export function currentLogContext(): Readonly<LogIdentifiers> { return storage.getStore() ?? {}; }
export function runWithLogContext<T>(identifiers: LogIdentifiers, work: () => T): T {
  // Keep the original envelope identifiers in context; output filtering must not
  // normalize or replace existing SQS/business correlation contracts.
  const context: Record<string, string> = {};
  for (const key of keys) {
    const id = identifiers[key];
    if (typeof id === 'string') context[key] = id;
  }
  return storage.run(Object.freeze(context), work);
}
