import { createHash } from 'node:crypto';
import { DomainError } from '../../../shared/domain/domain-error';
import { assertIdentifier } from '../../../shared/domain/financial-rules';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { WagerTransactionKind as Kind } from '../domain/wager-transaction.types';

export interface WagerBusinessRequest {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: Exclude<Kind, Kind.Opening>;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
}

export interface WagerIdentityRequest extends WagerBusinessRequest {
  readonly idempotencyKey: string;
}

type CanonicalValue = string | { readonly [key: string]: CanonicalValue };

// The projected contract has only strings and nested objects. No monetary numbers enter JSON.
function canonicalJson(value: CanonicalValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
}

export class WagerRequestFingerprint {
  private constructor(
    readonly idempotencyKey: string,
    readonly business: Readonly<WagerBusinessRequest>,
    readonly money: Money,
    readonly canonicalJson: string,
    readonly payloadHash: string,
  ) { Object.freeze(this); }

  static from(request: WagerIdentityRequest): WagerRequestFingerprint {
    for (const value of [request.idempotencyKey, request.providerId, request.externalTransactionId,
      request.playerId, request.walletId, request.roundId, request.gameId]) assertIdentifier(value);
    if (!Object.values(Kind).includes(request.kind) || (request.kind as Kind) === Kind.Opening) {
      throw new DomainError('INVALID_EXTERNAL_TRANSACTION_KIND', 'Identity requires an external wager kind');
    }
    if (request.referenceExternalTransactionId !== undefined) assertIdentifier(request.referenceExternalTransactionId);
    const money = Money.from(request.money);
    const business = Object.freeze({
      providerId: request.providerId, externalTransactionId: request.externalTransactionId,
      playerId: request.playerId, walletId: request.walletId, roundId: request.roundId,
      gameId: request.gameId, kind: request.kind, money: Object.freeze(money.toJSON()),
      ...(request.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: request.referenceExternalTransactionId }),
    });
    const json = canonicalJson({ ...business, money: { amount: money.toString(), currency: money.currency } });
    return new WagerRequestFingerprint(request.idempotencyKey, business, money, json,
      createHash('sha256').update(json, 'utf8').digest('hex'));
  }
}
