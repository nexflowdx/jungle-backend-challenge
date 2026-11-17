import { describe, expect, test } from 'bun:test';
import { WagerTransactionIdentity, WagerIdentityCollisionError, WagerIdentityConflictError } from '../../src/modules/wagering/application/wager-transaction-identity';
import type { WagerIdentityRequest } from '../../src/modules/wagering/application/wager-request-fingerprint';
import type { WagerProcessingTransaction, WagerProcessingUnitOfWork } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import type { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';

const at = new Date('2026-11-17T12:00:00.000Z');
const identity = new WagerTransactionIdentity();
const unusedFinancial = {
  lockWallet: async () => { throw new Error('Identity classification must not lock wallets'); },
  findReference: async () => { throw new Error('Identity classification must not load references'); },
  loadTransaction: async () => { throw new Error('Identity classification must not load results'); },
  saveWallet: async () => { throw new Error('Identity classification must not change wallets'); },
  completeTransaction: async () => { throw new Error('Identity classification must not complete transactions'); },
  insertLedgerEntry: async () => { throw new Error('Identity classification must not write ledger'); },
  insertEvents: async () => { throw new Error('Identity classification must not emit events'); },
};
let sequence = 0;
function candidate(overrides: Partial<WagerIdentityRequest> = {}): WagerTransaction {
  return identity.createCandidate({ providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key',
    playerId: 'player', walletId: 'wallet', roundId: 'round', gameId: 'game', kind: Kind.Bet,
    money: { amount: '001.00', currency: 'BRL' }, ...overrides }, `candidate-${++sequence}`, at);
}
function persistence(rows: WagerTransaction[] = []) {
  let reads = 0;
  let writes = 0;
  const scope: WagerProcessingTransaction = {
    ...unusedFinancial,
    findIdentityCandidates: async key => {
      reads++;
      return rows.filter(row => row.idempotencyKey === key.idempotencyKey
        || (row.providerId === key.providerId && row.externalTransactionId === key.externalTransactionId));
    },
    insertPending: async row => { writes++; rows.push(row); },
  };
  return { scope, rows, reads: () => reads, writes: () => writes };
}

describe('wager identity classification only (5.2)', () => {
  test('builds an exact PENDING candidate without inventing a financial snapshot', () => {
    const tx = candidate();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.money.toString()).toBe('1.00');
    expect(tx.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tx.balance).toBeUndefined();
    expect(tx.acceptedBalance).toBeUndefined();
    expect(tx.completedAt).toBeUndefined();
  });
  test('inserts into the supplied scope and returns only technical identity fields', async () => {
    const tx = candidate();
    const store = persistence();
    expect(await identity.resolve(tx, store.scope)).toEqual({ kind: 'identity-created', transactionId: tx.id, payloadHash: tx.payloadHash });
    expect(store.reads()).toBe(1);
    expect(store.writes()).toBe(1);
    expect(store.rows[0]).toBe(tx);
  });
  test('same key, external identity and normalized hash replay the persisted identity without inserting', async () => {
    const original = candidate();
    const store = persistence([original]);
    expect(await identity.resolve(candidate({ money: { amount: '1.00', currency: 'BRL' } }), store.scope))
      .toEqual({ kind: 'identity-replay', transactionId: original.id, payloadHash: original.payloadHash });
    expect(store.writes()).toBe(0);
  });
  test.each([
    { money: { amount: '2.00', currency: 'BRL' } }, { money: { amount: '1.00', currency: 'USD' } },
    { walletId: 'other' }, { playerId: 'other' }, { providerId: 'other' }, { externalTransactionId: 'other' },
    { roundId: 'other' }, { gameId: 'other' }, { kind: Kind.Win }, { referenceExternalTransactionId: 'reference' },
  ])('same global key with different business data conflicts: %j', async change => {
    const store = persistence([candidate()]);
    await expect(identity.resolve(candidate(change), store.scope)).rejects.toMatchObject({ code: 'WAGER_IDENTITY_CONFLICT', reason: 'PAYLOAD_MISMATCH' });
    expect(store.writes()).toBe(0);
  });
  test('same provider/external ID under a different key conflicts even with the same hash', async () => {
    const original = candidate();
    const next = candidate({ idempotencyKey: 'other' });
    expect(original.payloadHash).toBe(next.payloadHash);
    const store = persistence([original]);
    await expect(identity.resolve(next, store.scope)).rejects.toMatchObject({ reason: 'EXTERNAL_ID_REUSED' });
    expect(store.writes()).toBe(0);
  });
  test.each([
    { idempotencyKey: 'second', externalTransactionId: 'second' },
    { idempotencyKey: 'second', providerId: 'another-provider' },
  ])('distinct identities remain independent: %j', async overrides => {
    const store = persistence([candidate()]);
    expect((await identity.resolve(candidate(overrides), store.scope)).kind).toBe('identity-created');
    expect(store.rows).toHaveLength(2);
  });
  test('crossed identities conflict rather than choosing one persisted row arbitrarily', async () => {
    const store = persistence([candidate(), candidate({ idempotencyKey: 'second', externalTransactionId: 'second' })]);
    await expect(identity.resolve(candidate({ externalTransactionId: 'second' }), store.scope))
      .rejects.toMatchObject({ reason: 'CROSSED_IDENTITIES' });
    expect(store.writes()).toBe(0);
  });
  test.each(['idempotency-key', 'provider-external'] as const)('recovers %s collision through a fresh read-only unit of work', async source => {
    const original = candidate();
    const store = persistence([original]);
    let transactions = 0;
    const work: WagerProcessingUnitOfWork = { transaction: async callback => { transactions++; return callback(store.scope); } };
    expect(await identity.recoverAfterRollback(candidate(), new WagerIdentityCollisionError(source), work))
      .toEqual({ kind: 'identity-replay', transactionId: original.id, payloadHash: original.payloadHash });
    expect(transactions).toBe(1);
    expect(store.writes()).toBe(0);
  });
  test.each([new Error('connection lost'), Object.assign(new Error('raw unique failure'), { code: '23505' }),
    { code: 'WAGER_IDENTITY_COLLISION' }, new WagerIdentityConflictError('PAYLOAD_MISMATCH')])(
    'does not turn generic or unverified errors into identity conflicts: %s', async error => {
      let calls = 0;
      const work: WagerProcessingUnitOfWork = { transaction: async () => { calls++; throw new Error('must not query'); } };
      await expect(identity.recoverAfterRollback(candidate(), error, work)).rejects.toBe(error);
      expect(calls).toBe(0);
    },
  );
  test('propagates the original collision if no committed winner can be found', async () => {
    const store = persistence();
    const error = new WagerIdentityCollisionError('idempotency-key');
    const work: WagerProcessingUnitOfWork = { transaction: callback => callback(store.scope) };
    await expect(identity.recoverAfterRollback(candidate(), error, work)).rejects.toBe(error);
    expect(store.writes()).toBe(0);
  });
  test('classifies mismatching committed payload after rollback without another insertion', async () => {
    const store = persistence([candidate()]);
    const work: WagerProcessingUnitOfWork = { transaction: callback => callback(store.scope) };
    await expect(identity.recoverAfterRollback(candidate({ gameId: 'other' }), new WagerIdentityCollisionError('idempotency-key'), work))
      .rejects.toMatchObject({ reason: 'PAYLOAD_MISMATCH' });
    expect(store.writes()).toBe(0);
  });
  test.each(['find', 'insert'])('propagates %s errors to the owner of the transaction', async point => {
    const failure = new Error('persistence failed');
    const scope: WagerProcessingTransaction = {
      ...unusedFinancial,
      findIdentityCandidates: async () => { if (point === 'find') throw failure; return []; },
      insertPending: async () => { throw failure; },
    };
    await expect(identity.resolve(candidate(), scope)).rejects.toBe(failure);
  });
  test('reuses the domain validation for a zero BET candidate and missing REFUND reference', () => {
    expect(() => candidate({ money: { amount: '0.00', currency: 'BRL' } })).toThrow();
    expect(() => candidate({ kind: Kind.Refund })).toThrow();
  });
});
