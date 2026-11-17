import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { TransactionContext, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { walletMapper } from '../../src/database/domain-mappers';
import { WalletRecord, WagerTransactionRecord, LedgerEntryRecord, OutboxMessageRecord } from '../../src/database/entities';
import { createPersistence } from '../../src/database/orm';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';
import type { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { ProcessWagerTransaction, WagerProcessingNotImplementedError } from '../../src/modules/wagering/application/process-wager-transaction';
import type { WagerProcessingTransaction } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import type { WagerIdentityRequest } from '../../src/modules/wagering/application/wager-request-fingerprint';
import { WagerTransactionIdentity, WagerIdentityCollisionError, type WagerIdentityOutcome } from '../../src/modules/wagering/application/wager-transaction-identity';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { assertPersistenceTestEnvironment } from './environment';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
const at = new Date('2026-11-17T12:00:00.000Z');
const identity = new WagerTransactionIdentity();
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// PENDING records below are controlled persistence fixtures, never public acceptance of a wager.
describe.skipIf(!enabled)('Persistent wager identity PostgreSQL integration (5.2)', () => {
  let orm: MikroORM;
  const connection = () => ({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test',
    user: 'diagnostic', password: process.env.PGPASSWORD! });
  const fresh = () => orm.em.fork();
  const work = () => new PostgresWagerProcessingUnitOfWork(orm);
  const candidate = (request: WagerIdentityRequest, id: string = randomUUID()) => identity.createCandidate(request, id, at);
  const commitFixture = (tx: WagerTransaction) => work().transaction(scope => scope.insertPending(tx));
  const resolveFixture = (tx: WagerTransaction) => work().transaction(scope => identity.resolve(tx, scope));
  async function wallet(currency = 'BRL'): Promise<Wallet> {
    const target = Wallet.open({ id: randomUUID(), playerId: randomUUID(), initialBalance: Money.zero(currency), at });
    await fresh().persistAndFlush(walletMapper.toRecord(target));
    return target;
  }
  function request(target: Wallet, overrides: Partial<WagerIdentityRequest> = {}): WagerIdentityRequest {
    return { idempotencyKey: randomUUID(), providerId: 'provider', externalTransactionId: randomUUID(),
      playerId: target.playerId, walletId: target.id, roundId: 'round', gameId: 'game', kind: Kind.Bet,
      money: { amount: '1.00', currency: target.currency }, ...overrides };
  }
  async function unchanged(target: Wallet): Promise<void> {
    const stored = await fresh().findOneOrFail(WalletRecord, target.id);
    expect(stored.balance).toBe('0.00');
    expect(stored.version).toBe(1);
    expect(await fresh().count(LedgerEntryRecord, { walletId: target.id })).toBe(0);
    expect(await fresh().count(OutboxMessageRecord, { aggregateId: target.id })).toBe(0);
    for (const row of await fresh().find(WagerTransactionRecord, { walletId: target.id })) {
      expect(row.status).toBe(Status.Pending);
      expect(row.acceptedBalance).toBeNull();
      expect(row.balance).toBeNull();
      expect(row.completedAt).toBeNull();
    }
  }
  function currentManager() {
    const manager = TransactionContext.getEntityManager();
    if (!manager) throw new Error('Expected transaction context in infrastructure test');
    return manager;
  }
  async function backendPid(): Promise<number> {
    const manager = currentManager();
    const rows = await manager.getConnection().execute('SELECT pg_backend_pid() AS pid', [], 'all', manager.getTransactionContext());
    return rows[0].pid as number; // Connection identifier only, never money.
  }
  async function waitForLock(pid: number): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [row] = await fresh().execute<{ wait_event_type: string | null }[]>(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid=?', [pid]);
      if (row?.wait_event_type === 'Lock') return;
      await Bun.sleep(10);
    }
    throw new Error('Concurrent identity insert did not reach a PostgreSQL lock wait');
  }
  async function race(first: WagerTransaction, second: WagerTransaction, rollbackFirst: boolean) {
    const inserted = latch();
    const release = latch();
    const secondStarted = latch();
    const failure = new Error('Rollback the uncommitted identity fixture');
    let pid = 0;
    let secondPromise: Promise<WagerIdentityOutcome> | undefined;
    const firstPromise = work().transaction(async scope => {
      await scope.insertPending(first);
      inserted.resolve();
      await release.promise;
      if (rollbackFirst) throw failure;
    });
    // Register a rejection handler immediately while the test controls the commit barrier.
    void firstPromise.catch(() => {});
    try {
      await Promise.race([inserted.promise, firstPromise.then(() => { throw new Error('Fixture committed before release'); })]);
      secondPromise = work().transaction(async scope => {
        expect(await scope.findIdentityCandidates(second)).toHaveLength(0); // No dirty read.
        pid = await backendPid();
        secondStarted.resolve();
        return identity.resolve(second, scope);
      });
      void secondPromise.catch(() => {});
      await Promise.race([secondStarted.promise, secondPromise.then(() => { throw new Error('Insert unexpectedly completed'); })]);
      await waitForLock(pid);
      release.resolve();
      const results = await Promise.allSettled([firstPromise, secondPromise]);
      return { first: results[0], second: results[1], failure };
    } finally {
      release.resolve();
      await Promise.allSettled(secondPromise ? [firstPromise, secondPromise] : [firstPromise]);
    }
  }

  beforeAll(async () => {
    assertPersistenceTestEnvironment(process.env);
    orm = await createPersistence(connection());
    await orm.getMigrator().up();
  }, 30000);
  afterAll(async () => { if (orm) await orm.close(true); });

  test.each([
    ['0.01', 'BRL'], ['1.00', 'BRL'], ['9007199254740993.01', 'BRL'], ['92233720368547758.07', 'BRL'],
    ['0.01', 'USD'], ['1.00', 'USD'], ['9007199254740993.01', 'USD'], ['92233720368547758.07', 'USD'],
  ])('persists exact identity money %s %s without financial effects', async (amount, currency) => {
    const target = await wallet(currency!);
    const tx = candidate(request(target, { money: { amount: amount!, currency: currency! } }));
    expect(await resolveFixture(tx)).toEqual({ kind: 'identity-created', transactionId: tx.id, payloadHash: tx.payloadHash });
    const stored = await fresh().findOneOrFail(WagerTransactionRecord, tx.id);
    expect(stored.amount).toBe(amount!);
    expect(stored.payloadHash).toBe(tx.payloadHash);
    await unchanged(target);
  });

  test.each(['commit', 'rollback'])('scope inserts and queries use the same PostgreSQL transaction: %s', async outcome => {
    const target = await wallet();
    const tx = candidate(request(target));
    const failure = new Error('Injected scope rollback');
    const pending = work().transaction(async scope => {
      expect(await scope.findIdentityCandidates(tx)).toHaveLength(0);
      await scope.insertPending(tx);
      const rows = await scope.findIdentityCandidates(tx);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(tx.id);
      expect((await identity.resolve(candidate(request(target, { idempotencyKey: tx.idempotencyKey,
        externalTransactionId: tx.externalTransactionId })), scope)).kind).toBe('identity-replay');
      expect(await fresh().count(WagerTransactionRecord, { id: tx.id })).toBe(0);
      if (outcome === 'rollback') throw failure;
    });
    if (outcome === 'rollback') await expect(pending).rejects.toBe(failure);
    else await pending;
    expect(await fresh().count(WagerTransactionRecord, { id: tx.id })).toBe(outcome === 'commit' ? 1 : 0);
    await unchanged(target);
  });

  test('same normalized payload replays after restarting the persistence client', async () => {
    const target = await wallet();
    const input = request(target, { money: { amount: '001.00', currency: 'BRL' } });
    const first = candidate(input);
    await resolveFixture(first);
    const restarted = await createPersistence(connection());
    try {
      const next = candidate({ ...input, money: { amount: '1.00', currency: 'BRL' } });
      const outcome = await new PostgresWagerProcessingUnitOfWork(restarted).transaction(scope => identity.resolve(next, scope));
      expect(outcome).toEqual({ kind: 'identity-replay', transactionId: first.id, payloadHash: first.payloadHash });
      expect(await fresh().count(WagerTransactionRecord, { idempotencyKey: first.idempotencyKey })).toBe(1);
    } finally { await restarted.close(true); }
    await unchanged(target);
  });

  test.each([
    { money: { amount: '2.00', currency: 'BRL' } }, { money: { amount: '1.00', currency: 'USD' } }, { gameId: 'different' },
  ])('same key with changed payload conflicts without another row: %j', async overrides => {
    const target = await wallet();
    const input = request(target);
    await resolveFixture(candidate(input));
    await expect(resolveFixture(candidate({ ...input, ...overrides }))).rejects.toMatchObject({ reason: 'PAYLOAD_MISMATCH' });
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id })).toBe(1);
    await unchanged(target);
  });

  test('provider/external ID reused under another key conflicts despite an identical hash', async () => {
    const target = await wallet();
    const input = request(target);
    const first = candidate(input);
    const second = candidate({ ...input, idempotencyKey: randomUUID() });
    expect(first.payloadHash).toBe(second.payloadHash);
    await resolveFixture(first);
    await expect(resolveFixture(second)).rejects.toMatchObject({ reason: 'EXTERNAL_ID_REUSED' });
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id })).toBe(1);
    await unchanged(target);
  });

  test('crossed identities query both committed candidates and conflict', async () => {
    const target = await wallet();
    const first = candidate(request(target));
    const second = candidate(request(target));
    await commitFixture(first); await commitFixture(second);
    const crossed = candidate(request(target, { idempotencyKey: first.idempotencyKey, externalTransactionId: second.externalTransactionId }));
    await expect(resolveFixture(crossed)).rejects.toMatchObject({ reason: 'CROSSED_IDENTITIES' });
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id })).toBe(2);
    await unchanged(target);
  });

  test.each(['different-external', 'different-provider', 'different-wallet'])('distinct identities remain independent: %s', async variation => {
    const firstWallet = await wallet();
    const secondWallet = variation === 'different-wallet' ? await wallet('USD') : firstWallet;
    const first = request(firstWallet);
    const second = request(secondWallet, { providerId: variation === 'different-provider' ? 'another-provider' : first.providerId,
      externalTransactionId: variation === 'different-provider' ? first.externalTransactionId : randomUUID() });
    const outcomes = await Promise.all([resolveFixture(candidate(first)), resolveFixture(candidate(second))]);
    expect(outcomes.map(outcome => outcome.kind)).toEqual(['identity-created', 'identity-created']);
    expect(new Set(outcomes.map(outcome => outcome.transactionId)).size).toBe(2);
    await unchanged(firstWallet); await unchanged(secondWallet);
  });

  test.each(['primary-key', 'foreign-key'])('does not classify an unrelated %s constraint as idempotency conflict', async constraint => {
    const target = await wallet();
    const first = candidate(request(target));
    await commitFixture(first);
    const second = candidate(request(target, constraint === 'foreign-key' ? { walletId: randomUUID() } : {}),
      constraint === 'primary-key' ? first.id : randomUUID());
    let error: unknown;
    try { await commitFixture(second); } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(WagerIdentityCollisionError);
    expect(error).toMatchObject({ code: constraint === 'primary-key' ? '23505' : '23503' });
    await expect(identity.recoverAfterRollback(second, error, work())).rejects.toBe(error);
    await unchanged(target);
  });

  test('does not classify a generic thrown error with forged PostgreSQL fields as an identity collision', async () => {
    const error = Object.assign(new Error('generic callback error'), { code: '23505', constraint: 'wager_transactions_idempotency_key_key' });
    await expect(work().transaction(async () => { throw error; })).rejects.toBe(error);
    expect(error).not.toBeInstanceOf(WagerIdentityCollisionError);
  });

  test.each(['commit', 'rollback'])('an escaped scope cannot query or insert after %s', async outcome => {
    const target = await wallet();
    const tx = candidate(request(target));
    let escaped!: WagerProcessingTransaction;
    const pending = work().transaction(async scope => { escaped = scope; if (outcome === 'rollback') throw new Error('rollback'); });
    if (outcome === 'rollback') await expect(pending).rejects.toThrow('rollback'); else await pending;
    await expect(escaped.findIdentityCandidates(tx)).rejects.toThrow('closed or failed');
    await expect(escaped.insertPending(tx)).rejects.toThrow('closed or failed');
    expect(await fresh().count(WagerTransactionRecord, { id: tx.id })).toBe(0);
    await unchanged(target);
  });

  test('a swallowed UNIQUE failure cannot commit earlier writes or continue querying an aborted scope', async () => {
    const target = await wallet();
    const winner = candidate(request(target));
    await commitFixture(winner);
    const preceding = candidate(request(target));
    const duplicate = candidate(request(target, { idempotencyKey: winner.idempotencyKey, externalTransactionId: winner.externalTransactionId }));
    let collision: unknown;
    try { await work().transaction(async scope => {
      await scope.insertPending(preceding);
      try { await scope.insertPending(duplicate); } catch (error) {
        expect(error).toBeInstanceOf(UniqueConstraintViolationException);
        expect(error).not.toBeInstanceOf(WagerIdentityCollisionError); // Not translated before rollback.
      }
      await expect(scope.findIdentityCandidates(winner)).rejects.toThrow('closed or failed');
      return 'must not become a successful commit';
    }); } catch (error) { collision = error; }
    expect(collision).toBeInstanceOf(WagerIdentityCollisionError);
    expect(await fresh().count(WagerTransactionRecord, { id: preceding.id })).toBe(0);
    const result = await identity.recoverAfterRollback(duplicate, collision, work());
    expect(result.transactionId).toBe(winner.id);
    await unchanged(target);
  });

  test.each(['commit', 'rollback'])('concurrent identical identities wait for the first transaction to %s', async outcome => {
    const target = await wallet();
    const input = request(target);
    const first = candidate(input); const second = candidate(input);
    const result = await race(first, second, outcome === 'rollback');
    if (outcome === 'commit') {
      expect(result.first!.status).toBe('fulfilled');
      expect(result.second!.status).toBe('rejected');
      if (result.second!.status !== 'rejected') throw new Error('Expected identity collision');
      expect(result.second!.reason).toBeInstanceOf(WagerIdentityCollisionError);
      const recovered = await identity.recoverAfterRollback(second, result.second!.reason, work());
      expect(recovered).toMatchObject({ kind: 'identity-replay', transactionId: first.id });
    } else {
      expect(result.first).toMatchObject({ status: 'rejected', reason: result.failure });
      expect(result.second).toMatchObject({ status: 'fulfilled', value: { kind: 'identity-created', transactionId: second.id } });
    }
    expect(await fresh().count(WagerTransactionRecord, { idempotencyKey: first.idempotencyKey })).toBe(1);
    await unchanged(target);
  });

  test.each(['payload', 'external-key', 'wallet-context'])('classifies concurrent %s conflicts only after rollback and a fresh lookup', async variation => {
    const target = await wallet();
    const other = variation === 'wallet-context' ? await wallet('USD') : target;
    const input = request(target);
    const first = candidate(input);
    const second = candidate({ ...input, ...(variation === 'payload'
      ? { money: { amount: '2.00', currency: 'BRL' } } : variation === 'external-key'
        ? { idempotencyKey: randomUUID() }
        : { walletId: other.id, playerId: other.playerId, money: { amount: '1.00', currency: 'USD' } }) });
    const result = await race(first, second, false);
    expect(result.first!.status).toBe('fulfilled');
    if (result.second!.status !== 'rejected') throw new Error('Expected identity collision');
    expect(result.second!.reason).toBeInstanceOf(WagerIdentityCollisionError);
    await expect(identity.recoverAfterRollback(second, result.second!.reason, work()))
      .rejects.toMatchObject({ reason: variation === 'external-key' ? 'EXTERNAL_ID_REUSED' : 'PAYLOAD_MISMATCH' });
    await unchanged(target); await unchanged(other);
  });

  test('a lock timeout rolls back the contender without replaying an uncommitted identity or marking it failed', async () => {
    const target = await wallet();
    const input = request(target);
    const first = candidate(input); const second = candidate(input);
    const inserted = latch(); const release = latch();
    const winner = work().transaction(async scope => { await scope.insertPending(first); inserted.resolve(); await release.promise; });
    void winner.catch(() => {});
    try {
      await Promise.race([inserted.promise, winner.then(() => { throw new Error('Premature commit'); })]);
      let error: unknown;
      try {
        await work().transaction(async scope => {
          const manager = currentManager();
          await manager.getConnection().execute("SET LOCAL lock_timeout='250ms'", [], 'all', manager.getTransactionContext());
          return identity.resolve(second, scope);
        });
      } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: '55P03' });
      expect(error).not.toBeInstanceOf(WagerIdentityCollisionError);
      await expect(identity.recoverAfterRollback(second, error, work())).rejects.toBe(error);
      expect(await work().transaction(scope => scope.findIdentityCandidates(first))).toHaveLength(0);
      release.resolve(); await winner;
      expect(await resolveFixture(second)).toMatchObject({ kind: 'identity-replay', transactionId: first.id });
    } finally { release.resolve(); await winner; }
    expect(await fresh().count(WagerTransactionRecord, { id: second.id })).toBe(0);
    await unchanged(target);
  });

  test('an unsupported public operation never registers a PENDING reservation', async () => {
    const target = await wallet();
    await expect(new ProcessWagerTransaction(work()).execute({ walletId: target.id, kind: Kind.Refund }))
      .rejects.toBeInstanceOf(WagerProcessingNotImplementedError);
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id })).toBe(0);
    await unchanged(target);
  });
});
