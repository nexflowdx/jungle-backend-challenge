import { describe, expect, test } from 'bun:test';
import { WagerRequestFingerprint, type WagerIdentityRequest } from '../../src/modules/wagering/application/wager-request-fingerprint';
import { WagerTransactionKind as Kind } from '../../src/modules/wagering/domain/wager-transaction.types';

const request = (overrides: Partial<WagerIdentityRequest> = {}): WagerIdentityRequest => ({
  idempotencyKey: 'key', providerId: 'provider', externalTransactionId: 'external', playerId: 'player',
  walletId: 'wallet', roundId: 'round', gameId: 'game', kind: Kind.Bet,
  money: { amount: '001.00', currency: 'BRL' }, ...overrides,
});
const canonical = '{"externalTransactionId":"external","gameId":"game","kind":"BET","money":{"amount":"1.00","currency":"BRL"},"playerId":"player","providerId":"provider","roundId":"round","walletId":"wallet"}';

describe('wager request fingerprint (5.2)', () => {
  test('matches the documented canonical bytes and independently calculated SHA-256', () => {
    const result = WagerRequestFingerprint.from(request());
    expect(result.canonicalJson).toBe(canonical);
    expect(result.payloadHash).toBe('d113aa12eb7035f8125c874cbbd3afc09448b8c06b460dc10ca0ff6f60f80c2d');
  });
  test('ignores input key order, including nested money keys', () => {
    const reversed = Object.fromEntries(Object.entries(request()).reverse()) as unknown as WagerIdentityRequest;
    expect(WagerRequestFingerprint.from({ ...reversed, money: { currency: 'BRL', amount: '001.00' } }).canonicalJson).toBe(canonical);
  });
  test('projects business fields and excludes keys, transport metadata, internal IDs and supplied hashes', () => {
    const enriched = { ...request(), idempotencyKey: 'another-key', correlationId: 'correlation', causationId: 'cause',
      messageId: 'message', transactionId: 'internal-id', createdAt: 'different-time', payloadHash: 'untrusted',
      headers: { authorization: 'fixture' }, metadata: { attempt: 5 } };
    expect(WagerRequestFingerprint.from(enriched).canonicalJson).toBe(canonical);
    expect(WagerRequestFingerprint.from(enriched).payloadHash).toBe(WagerRequestFingerprint.from(request()).payloadHash);
  });
  test.each([
    { providerId: 'other' }, { externalTransactionId: 'other' }, { playerId: 'other' }, { walletId: 'other' },
    { roundId: 'other' }, { gameId: 'other' }, { kind: Kind.Win },
    { money: { amount: '1.01', currency: 'BRL' } }, { money: { amount: '1.00', currency: 'USD' } },
    { referenceExternalTransactionId: 'reference' },
  ])('changes the hash when business data changes: %j', overrides => {
    expect(WagerRequestFingerprint.from(request(overrides)).payloadHash).not.toBe(WagerRequestFingerprint.from(request()).payloadHash);
  });
  test.each(['1.00', '01.00', '0001.00'])('normalizes leading monetary zeros in %s', amount => {
    expect(WagerRequestFingerprint.from(request({ money: { amount, currency: 'BRL' } })).canonicalJson).toBe(canonical);
  });
  test.each(['0.00', '0.01', '9007199254740993.01', '92233720368547758.07'])('preserves exact monetary strings %s', amount => {
    const result = WagerRequestFingerprint.from(request({ money: { amount, currency: 'USD' } }));
    expect(JSON.parse(result.canonicalJson).money).toEqual({ amount, currency: 'USD' });
    expect(result.money.toString()).toBe(amount);
  });
  test.each([1, undefined, '1.0', '1.001', '1.230', '-1.00', 'NaN', 'Infinity', '1e2', '92233720368547758.08'])(
    'rejects invalid monetary input %s instead of rounding or coercing it', amount => {
      expect(() => WagerRequestFingerprint.from(request({ money: { amount: amount as string, currency: 'BRL' } }))).toThrow();
    },
  );
  test('omits an absent or undefined optional reference and rejects null/empty references', () => {
    expect(WagerRequestFingerprint.from(request()).business).not.toHaveProperty('referenceExternalTransactionId');
    const explicitUndefined = { ...request(), referenceExternalTransactionId: undefined } as unknown as WagerIdentityRequest;
    expect(WagerRequestFingerprint.from(explicitUndefined).canonicalJson).toBe(canonical);
    for (const reference of [null, '']) {
      expect(() => WagerRequestFingerprint.from(request({ referenceExternalTransactionId: reference as string }))).toThrow();
    }
  });
  test('preserves identifier case, whitespace, unicode and JSON escaping without transport normalization', () => {
    const result = WagerRequestFingerprint.from(request({ gameId: 'á\n"game"\\', providerId: ' Provider ' }));
    expect(JSON.parse(result.canonicalJson).gameId).toBe('á\n"game"\\');
    expect(JSON.parse(result.canonicalJson).providerId).toBe(' Provider ');
    expect(result.payloadHash).not.toBe(WagerRequestFingerprint.from(request({ gameId: 'á\n"game"\\', providerId: 'provider' })).payloadHash);
  });
  test.each([
    { idempotencyKey: '' }, { providerId: '' }, { kind: Kind.Opening as WagerIdentityRequest['kind'] },
    { kind: 'OTHER' as WagerIdentityRequest['kind'] }, { money: { amount: '1.00', currency: 'EUR' } },
  ])('rejects invalid identifiers, kinds or currencies: %j', overrides => {
    expect(() => WagerRequestFingerprint.from(request(overrides))).toThrow();
  });
  test('copies and freezes normalized business data', () => {
    const input = { ...request(), money: { amount: '1.00', currency: 'BRL' } };
    const fingerprint = WagerRequestFingerprint.from(input);
    input.money.amount = '200.00';
    expect(fingerprint.business.money.amount).toBe('1.00');
    expect(Object.isFrozen(fingerprint)).toBe(true);
    expect(Object.isFrozen(fingerprint.business)).toBe(true);
    expect(Object.isFrozen(fingerprint.business.money)).toBe(true);
  });
});
