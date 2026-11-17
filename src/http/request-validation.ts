import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { assertIdentifier } from '../shared/domain/financial-rules';
import { Money, type MoneyProps } from '../shared/domain/money';
import type { OpenWalletCommand } from '../modules/wallets/application/open-wallet';
import { WagerTransactionIdentity } from '../modules/wagering/application/wager-transaction-identity';
import type { SupportedWagerCommand } from '../modules/wagering/application/process-wager-transaction';
import { WagerTransactionKind as Kind } from '../modules/wagering/domain/wager-transaction.types';

export type WalletRequest = Pick<OpenWalletCommand, 'playerId' | 'initialBalance'>;
export type WagerRequest = Omit<SupportedWagerCommand, 'idempotencyKey' | 'correlationId' | 'causationId'>;
const invalid = (): never => { throw new BadRequestException(); };
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
function money(value: unknown): MoneyProps {
  const data = object(value, ['amount', 'currency']);
  // No coercion or transformation: domain Money owns decimal, currency and magnitude validation.
  if (typeof data.amount !== 'string' || typeof data.currency !== 'string') return invalid();
  try { return Money.from({ amount: data.amount, currency: data.currency }).toJSON(); } catch { return invalid(); }
}

@Injectable()
export class WalletRequestPipe implements PipeTransform<unknown, WalletRequest> {
  transform(value: unknown): WalletRequest {
    const data = object(value, ['playerId', 'initialBalance']);
    return { playerId: identifier(data.playerId), initialBalance: money(data.initialBalance) };
  }
}
@Injectable()
export class WagerRequestPipe implements PipeTransform<unknown, WagerRequest> {
  transform(value: unknown): WagerRequest {
    const data = object(value, ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money'], ['referenceExternalTransactionId']);
    if (data.kind !== Kind.Bet && data.kind !== Kind.Win && data.kind !== Kind.Loss && data.kind !== Kind.Refund && data.kind !== Kind.Rollback) return invalid();
    const request: WagerRequest = {
      providerId: identifier(data.providerId), externalTransactionId: identifier(data.externalTransactionId),
      playerId: identifier(data.playerId), walletId: identifier(data.walletId), roundId: identifier(data.roundId), gameId: identifier(data.gameId),
      kind: data.kind, money: money(data.money),
      ...(Object.hasOwn(data, 'referenceExternalTransactionId') ? { referenceExternalTransactionId: identifier(data.referenceExternalTransactionId) } : {}),
    };
    // BET/LOSS with references remain outside the supported application contract.
    if ((request.kind === Kind.Bet || request.kind === Kind.Loss) && request.referenceExternalTransactionId !== undefined) return invalid();
    // Reuse the existing factory for positive amounts and mandatory full-reference contracts.
    try { new WagerTransactionIdentity().createCandidate({ ...request, idempotencyKey: 'http-validation' }, 'http-validation', new Date()); }
    catch { return invalid(); }
    return request;
  }
}

export function idempotencyKey(request: Pick<IncomingMessage, 'headers' | 'rawHeaders'>): string {
  const value = request.headers['idempotency-key'];
  const occurrences = request.rawHeaders.filter((_, index, headers) => index % 2 === 0 && headers[index]!.toLowerCase() === 'idempotency-key').length;
  // Exactly one printable ASCII token. Commas also reject intermediary-merged duplicate headers.
  if (occurrences !== 1 || typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value) || value.includes(',')) return invalid();
  return value;
}
