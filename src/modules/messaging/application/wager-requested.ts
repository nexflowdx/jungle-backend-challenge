import { assertIdentifier } from '../../../shared/domain/financial-rules';
import type { SupportedWagerCommand } from '../../wagering/application/process-wager-transaction';
import { WagerTransactionIdentity } from '../../wagering/application/wager-transaction-identity';
import { WagerTransactionKind as Kind } from '../../wagering/domain/wager-transaction.types';

export interface WagerTransactionRequested {
  readonly messageId: string;
  readonly type: 'WagerTransactionRequested';
  readonly occurredAt: string;
  readonly data: Omit<SupportedWagerCommand, 'correlationId' | 'causationId'>;
}
export class InvalidWagerMessageError extends Error {
  readonly code = 'INVALID_WAGER_MESSAGE';
  constructor() { super('Invalid WagerTransactionRequested message'); this.name = 'InvalidWagerMessageError'; }
}
function invalid(): never { throw new InvalidWagerMessageError(); }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const data = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) return invalid();
  return data;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  try { assertIdentifier(value); } catch { return invalid(); }
  return value;
}

/** Transport validation only. Money and transaction invariants remain in the existing domain factory. */
export function parseWagerTransactionRequested(value: unknown): WagerTransactionRequested {
  const envelope = object(value, ['messageId', 'type', 'occurredAt', 'data']);
  const messageId = identifier(envelope.messageId);
  if (envelope.type !== 'WagerTransactionRequested' || typeof envelope.occurredAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(envelope.occurredAt)) return invalid();
  const at = new Date(envelope.occurredAt);
  if (!Number.isFinite(at.getTime()) || at.toISOString().replace('.000Z', 'Z') !== envelope.occurredAt.replace('.000Z', 'Z')) return invalid();
  const data = object(envelope.data, ['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money'], ['referenceExternalTransactionId']);
  const money = object(data.money, ['amount', 'currency']);
  if (typeof money.amount !== 'string' || typeof money.currency !== 'string') return invalid();
  if (data.kind !== Kind.Bet && data.kind !== Kind.Win && data.kind !== Kind.Loss && data.kind !== Kind.Refund && data.kind !== Kind.Rollback) return invalid();
  const request: WagerTransactionRequested['data'] = {
    providerId: identifier(data.providerId), externalTransactionId: identifier(data.externalTransactionId),
    idempotencyKey: identifier(data.idempotencyKey), playerId: identifier(data.playerId), walletId: identifier(data.walletId),
    roundId: identifier(data.roundId), gameId: identifier(data.gameId), kind: data.kind,
    money: { amount: money.amount, currency: money.currency },
    ...(Object.hasOwn(data, 'referenceExternalTransactionId') ? { referenceExternalTransactionId: identifier(data.referenceExternalTransactionId) } : {}),
  };
  if ((request.kind === Kind.Bet || request.kind === Kind.Loss) && request.referenceExternalTransactionId !== undefined) return invalid();
  try {
    const candidate = new WagerTransactionIdentity().createCandidate(request, messageId, at);
    return Object.freeze({ messageId, type: 'WagerTransactionRequested', occurredAt: envelope.occurredAt,
      data: Object.freeze({ ...request, money: Object.freeze(candidate.money.toJSON()) }) });
  } catch { return invalid(); }
}
