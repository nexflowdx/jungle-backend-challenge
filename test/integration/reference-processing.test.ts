import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { TransactionContext, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createPersistence } from '../../src/database/orm';
import { WalletRecord, WagerTransactionRecord, LedgerEntryRecord, OutboxMessageRecord } from '../../src/database/entities';
import { transactionMapper } from '../../src/database/domain-mappers';
import { Money } from '../../src/shared/domain/money';
import { OpenWallet } from '../../src/modules/wallets/application/open-wallet';
import { PostgresWalletOpeningUnitOfWork } from '../../src/modules/wallets/infrastructure/postgres-wallet-opening-unit-of-work';
import { ProcessWagerTransaction, type SupportedWagerCommand } from '../../src/modules/wagering/application/process-wager-transaction';
import type { WagerProcessingUnitOfWork } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { WagerTransactionIdentity, WagerIdentityCollisionError } from '../../src/modules/wagering/application/wager-transaction-identity';
import { WagerRequestFingerprint } from '../../src/modules/wagering/application/wager-request-fingerprint';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { assertPersistenceTestEnvironment } from './environment';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
type Target = { id: string; playerId: string; balance: { amount: string; currency: string } };
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe.skipIf(!enabled)('Durable WIN reference PostgreSQL integration (5.5)', () => {
  let orm: MikroORM;
  const connection = () => ({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test', user: 'diagnostic', password: process.env.PGPASSWORD! });
  const fresh = () => orm.em.fork();
  const work = () => new PostgresWagerProcessingUnitOfWork(orm);
  const processor = (scope: WagerProcessingUnitOfWork = work()) => new ProcessWagerTransaction(scope);
  const open = (amount = '100.00', currency = 'BRL') => new OpenWallet(new PostgresWalletOpeningUnitOfWork(orm))
    .execute({ playerId: randomUUID(), initialBalance: { amount, currency }, correlationId: randomUUID() });
  const command = (target: Target, overrides: Partial<SupportedWagerCommand> = {}): SupportedWagerCommand => ({
    kind: Kind.Win, walletId: target.id, playerId: target.playerId, idempotencyKey: randomUUID(), providerId: 'provider',
    externalTransactionId: randomUUID(), referenceExternalTransactionId: randomUUID(), gameId: 'game', roundId: 'round',
    money: { amount: '25.00', currency: target.balance.currency }, correlationId: randomUUID(), ...overrides,
  });
  const unreferenced = (target: Target, overrides: Partial<SupportedWagerCommand> = {}) => {
    const { referenceExternalTransactionId: _reference, ...input } = command(target, overrides); return input;
  };
  const outbox = async (target: Target, id: string) => (await fresh().find(OutboxMessageRecord, { aggregateId: target.id }))
    .filter(event => (event.payload.data as { transactionId: string }).transactionId === id);
  async function financialState(target: Target) {
    const wallet = await fresh().findOneOrFail(WalletRecord, target.id);
    return { balance: wallet.balance, version: wallet.version, updatedAt: wallet.updatedAt,
      ledger: await fresh().count(LedgerEntryRecord, { walletId: target.id }) };
  }
  async function pending(target: Target, input: SupportedWagerCommand, id: string, accepted = target.balance.amount) {
    expect(await fresh().findOneOrFail(WagerTransactionRecord, id)).toMatchObject({
      status: Status.PendingReference, acceptedBalance: accepted, acceptedCurrency: target.balance.currency,
      balance: null, balanceCurrency: null, completedAt: null, failureCode: null, referenceTransactionId: null,
      payloadHash: WagerRequestFingerprint.from(input).payloadHash, idempotencyKey: input.idempotencyKey,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });
    expect(await fresh().count(LedgerEntryRecord, { transactionId: id })).toBe(0);
    const events = await outbox(target, id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'WagerTransactionPendingReference', publishedAt: null });
    expect(events[0]!.payload).toMatchObject({ correlationId: input.correlationId,
      data: { status: Status.PendingReference, transactionId: id, balance: { amount: accepted, currency: target.balance.currency } } });
    expect(events[0]!.occurredAt).toBeInstanceOf(Date);
  }
  async function noWin(target: Target, before: Awaited<ReturnType<typeof financialState>>) {
    expect(await financialState(target)).toEqual(before);
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id, kind: Kind.Win })).toBe(0);
    expect((await fresh().find(OutboxMessageRecord, { aggregateId: target.id }))
      .filter(event => (event.payload.data as { kind?: Kind }).kind === Kind.Win)).toHaveLength(0);
  }
  // Controlled persisted fixtures for nonterminal and permanently failed references; not a public acceptance flow.
  async function fixture(target: Target, status: Status.Pending | Status.PendingReference | Status.Failed) {
    const request = status === Status.PendingReference ? command(target, { kind: Kind.Bet }) : unreferenced(target, { kind: Kind.Bet });
    const reference = new WagerTransactionIdentity().createCandidate(request, randomUUID(), new Date());
    if (status === Status.PendingReference) reference.markPendingReference(Money.from(target.balance));
    if (status === Status.Failed) reference.fail(FailureCode.PermanentInfrastructureFailure, Money.from(target.balance), new Date());
    await fresh().transactional(manager => manager.persistAndFlush(transactionMapper.toRecord(reference)));
    return reference;
  }
  function failAfter(point: string): WagerProcessingUnitOfWork {
    const fail = (name: string) => { if (point === name) throw new Error(`Injected ${point}`); };
    return { transaction: callback => work().transaction(async scope => {
      const result = await callback({ ...scope,
        insertPending: async tx => { await scope.insertPending(tx); fail('identity'); },
        findReference: async (provider, external) => { const reference = await scope.findReference(provider, external); fail('reference'); return reference; },
        completeTransaction: async tx => { await scope.completeTransaction(tx); fail('acceptance'); },
        insertEvents: async events => { await scope.insertEvents(events); fail('outbox'); },
      }); fail('commit'); return result;
    }) };
  }
  async function waitForLock(backend: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [row] = await fresh().execute<{ wait_event_type: string | null }[]>('SELECT wait_event_type FROM pg_stat_activity WHERE pid=?', [backend]);
      if (row?.wait_event_type === 'Lock') return;
      await Bun.sleep(10);
    }
    throw new Error('WIN did not wait for the reference writer wallet lock');
  }
  beforeAll(async () => { assertPersistenceTestEnvironment(process.env); orm = await createPersistence(connection()); await orm.getMigrator().up(); }, 30000);
  afterAll(async () => { if (orm) await orm.close(true); });

  test.each([['0.00', 'BRL'], ['100.00', 'BRL'], ['9007199254740993.01', 'USD']])(
    'missing reference preserves exact acceptance %s %s without any wallet or ledger write', async (amount, currency) => {
      const target = await open(amount!, currency!); const before = await financialState(target); const input = command(target);
      const guarded: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(scope => callback({ ...scope,
        saveWallet: async () => { throw new Error('Pending acceptance wrote the wallet'); },
        insertLedgerEntry: async () => { throw new Error('Pending acceptance wrote ledger'); },
      })) };
      const result = await processor(guarded).execute(input);
      expect(result).toMatchObject({ status: Status.PendingReference, balance: target.balance, idempotentReplay: false });
      expect(await financialState(target)).toEqual(before); await pending(target, input, result.transactionId);
    },
  );
  test('replay after wallet movement and client restart returns the stored acceptance', async () => {
    const target = await open(); const input = command(target); const first = await processor().execute(input);
    await processor().execute(unreferenced(target, { kind: Kind.Bet, money: { amount: '10.00', currency: 'BRL' } }));
    const restarted = await createPersistence(connection());
    try { expect(await new ProcessWagerTransaction(new PostgresWagerProcessingUnitOfWork(restarted)).execute({ ...input, correlationId: randomUUID() }))
      .toEqual({ ...first, idempotentReplay: true }); }
    finally { await restarted.close(true); }
    expect((await financialState(target)).balance).toBe('90.00'); await pending(target, input, first.transactionId);
  });
  test('replay does not resolve a pending WIN after its reference arrives', async () => {
    const target = await open(); const input = command(target); const first = await processor().execute(input);
    await processor().execute(unreferenced(target, { kind: Kind.Bet, externalTransactionId: input.referenceExternalTransactionId! }));
    const before = await financialState(target);
    const guarded: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(scope => callback({ ...scope,
      findReference: async () => { throw new Error('Replay attempted reference resolution'); },
      completeTransaction: async () => { throw new Error('Replay attempted reprocessing'); },
      insertEvents: async () => { throw new Error('Replay attempted another event'); },
    })) };
    expect(await processor(guarded).execute(input)).toEqual({ ...first, idempotentReplay: true });
    expect(await financialState(target)).toEqual(before); await pending(target, input, first.transactionId);
  });
  test.each(['payload', 'reference', 'external'])('pending identity conflict remains protected: %s', async change => {
    const target = await open(); const input = command(target); const result = await processor().execute(input);
    const before = await financialState(target);
    const altered = change === 'payload' ? { money: { amount: '26.00', currency: 'BRL' } }
      : change === 'reference' ? { referenceExternalTransactionId: randomUUID() } : { idempotencyKey: randomUUID() };
    await expect(processor().execute({ ...input, ...altered })).rejects.toMatchObject({ reason: change === 'external' ? 'EXTERNAL_ID_REUSED' : 'PAYLOAD_MISMATCH' });
    expect(await financialState(target)).toEqual(before); await pending(target, input, result.transactionId);
  });
  test('concurrent identical pending WINs persist one identity and one event', async () => {
    const target = await open(); const input = command(target); const before = await financialState(target);
    const results = await Promise.all(Array.from({ length: 10 }, () => processor().execute(input)));
    expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
    expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
    expect(await fresh().count(WagerTransactionRecord, { walletId: target.id, kind: Kind.Win })).toBe(1);
    expect(await financialState(target)).toEqual(before); await pending(target, input, results[0]!.transactionId);
  });
  test('valid processed BET reference credits the exact WIN with ledger and events atomically', async () => {
    const target = await open(); const bet = unreferenced(target, { kind: Kind.Bet, money: { amount: '10.00', currency: 'BRL' } });
    const reference = await processor().execute(bet);
    const input = command(target, { referenceExternalTransactionId: bet.externalTransactionId });
    const result = await processor().execute(input);
    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: '115.00', currency: 'BRL' } });
    expect(await fresh().findOneOrFail(WagerTransactionRecord, result.transactionId)).toMatchObject({ referenceTransactionId: reference.transactionId, acceptedBalance: null, balance: '115.00' });
    expect(await fresh().findOneOrFail(LedgerEntryRecord, { transactionId: result.transactionId })).toMatchObject({ direction: 'CREDIT', amount: '25.00', balanceBefore: '90.00', balanceAfter: '115.00', walletVersion: 3 });
    expect((await outbox(target, result.transactionId)).map(event => event.eventType).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const before = await financialState(target);
    expect(await processor().execute(input)).toEqual({ ...result, idempotentReplay: true }); expect(await financialState(target)).toEqual(before);
  });
  test.each(['round', 'currency', 'wallet', 'kind', 'rejected', 'failed', 'self'])('invalid reference is rejected without movement: %s', async reason => {
    const target = await open(); const other = reason === 'wallet' ? await open() : target;
    let referenceExternal: string;
    if (reason === 'failed') referenceExternal = (await fixture(target, Status.Failed)).externalTransactionId;
    else {
      const ref = unreferenced(other, { kind: reason === 'kind' ? Kind.Loss : Kind.Bet,
        ...(reason === 'round' ? { roundId: 'different' } : {}),
        money: { amount: reason === 'rejected' ? '101.00' : '10.00', currency: reason === 'currency' ? 'USD' : 'BRL' } });
      await processor().execute(ref); referenceExternal = ref.externalTransactionId;
    }
    const input = command(target, { referenceExternalTransactionId: referenceExternal });
    const before = await financialState(target);
    const result = await processor().execute(reason === 'self' ? { ...input, externalTransactionId: input.referenceExternalTransactionId! + '-self', referenceExternalTransactionId: input.referenceExternalTransactionId! + '-self' } : input);
    const codes = { round: FailureCode.ReferenceContextMismatch, currency: FailureCode.ReferenceContextMismatch, wallet: FailureCode.ReferenceContextMismatch,
      kind: FailureCode.ReferenceKindInvalid, rejected: FailureCode.ReferenceRejected, failed: FailureCode.ReferenceFailed, self: FailureCode.SelfReference };
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: codes[reason as keyof typeof codes] });
    expect(await financialState(target)).toEqual(before);
    expect(await fresh().count(LedgerEntryRecord, { transactionId: result.transactionId })).toBe(0);
    expect((await outbox(target, result.transactionId)).map(event => event.eventType)).toEqual(['WagerTransactionRejected']);
    expect(await processor().execute(reason === 'self' ? { ...input, externalTransactionId: input.referenceExternalTransactionId! + '-self', referenceExternalTransactionId: input.referenceExternalTransactionId! + '-self' } : input))
      .toEqual({ ...result, idempotentReplay: true });
  });
  test('reference lookup is scoped by provider, without accepting a different provider match', async () => {
    const target = await open(); const reference = unreferenced(target, { kind: Kind.Bet, providerId: 'other-provider' });
    await processor().execute(reference);
    const input = command(target, { referenceExternalTransactionId: reference.externalTransactionId }); const before = await financialState(target);
    const result = await processor().execute(input); expect(result.status).toBe(Status.PendingReference);
    expect(await financialState(target)).toEqual(before); await pending(target, input, result.transactionId, '75.00');
  });
  test.each([Status.Pending, Status.PendingReference])('reference in %s stays pending without effect', async status => {
    const target = await open(); const reference = await fixture(target, status); const input = command(target, { referenceExternalTransactionId: reference.externalTransactionId });
    const before = await financialState(target); const result = await processor().execute(input);
    expect(result.status).toBe(Status.PendingReference); expect(await financialState(target)).toEqual(before); await pending(target, input, result.transactionId);
  });
  test.each(['identity', 'reference', 'acceptance', 'outbox', 'commit'])('failure after %s rolls back identity, acceptance and event', async point => {
    const target = await open(); const input = command(target); const before = await financialState(target);
    await expect(processor(failAfter(point)).execute(input)).rejects.toThrow(`Injected ${point}`);
    await noWin(target, before);
    expect((await processor().execute(input)).idempotentReplay).toBe(false);
  });
  test.each(['ledger', 'outbox', 'commit'])('valid reference WIN rolls back its credit after %s failure', async point => {
    const target = await open(); const bet = unreferenced(target, { kind: Kind.Bet }); await processor().execute(bet);
    const before = await financialState(target); const input = command(target, { referenceExternalTransactionId: bet.externalTransactionId });
    const broken: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(async scope => {
      const result = await callback({ ...scope,
        insertLedgerEntry: async entry => { await scope.insertLedgerEntry(entry); if (point === 'ledger') throw new Error('Credit failure'); },
        insertEvents: async events => { await scope.insertEvents(events); if (point === 'outbox') throw new Error('Credit failure'); },
      }); if (point === 'commit') throw new Error('Credit failure'); return result;
    }) };
    await expect(processor(broken).execute(input)).rejects.toThrow('Credit failure'); await noWin(target, before);
  });
  test('acceptance is invisible and no result escapes before commit', async () => {
    const target = await open(); const input = command(target); const reached = latch(); const release = latch(); let id = ''; let returned = false;
    const held: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(async scope => {
      const result = await callback({ ...scope, completeTransaction: async tx => { await scope.completeTransaction(tx); id = tx.id; } });
      reached.resolve(); await release.promise; return result;
    }) };
    const running = processor(held).execute(input).then(result => { returned = true; return result; }); void running.catch(() => {});
    try {
      await Promise.race([reached.promise, running.then(() => { throw new Error('Premature acceptance'); })]);
      expect(returned).toBe(false); expect(await fresh().findOne(WagerTransactionRecord, id)).toBeNull();
      expect(await outbox(target, id)).toHaveLength(0); release.resolve(); const result = await running;
      expect(returned).toBe(true); await pending(target, input, result.transactionId);
    } finally { release.resolve(); await Promise.allSettled([running]); }
  });
  test('deferred FK failure at acceptance commit propagates and rolls back all artifacts', async () => {
    const target = await open(); const before = await financialState(target); let callbackFinished = false;
    const broken: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(async scope => {
      let id = '';
      const result = await callback({ ...scope, completeTransaction: async tx => { await scope.completeTransaction(tx); id = tx.id; } });
      const manager = TransactionContext.getEntityManager()!;
      await manager.getConnection().execute('UPDATE wager_transactions SET reference_transaction_id=? WHERE id=?', [randomUUID(), id], 'run', manager.getTransactionContext());
      callbackFinished = true; return result;
    }) };
    await expect(processor(broken).execute(command(target))).rejects.toMatchObject({ code: '23503' });
    expect(callbackFinished).toBe(true); await noWin(target, before);
  });
  test('real SQL reference read failure rolls back rather than returning PENDING_REFERENCE', async () => {
    const target = await open(); const before = await financialState(target);
    const broken: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(scope => callback({ ...scope,
      findReference: async () => {
        const manager = TransactionContext.getEntityManager()!;
        await manager.getConnection().execute('SELECT 1/0', [], 'all', manager.getTransactionContext()); return undefined;
      },
    })) };
    await expect(processor(broken).execute(command(target))).rejects.toMatchObject({ code: '22012' }); await noWin(target, before);
  });
  test('real outbox UNIQUE failure rolls back acceptance and is not an identity collision', async () => {
    const target = await open(); const before = await financialState(target);
    const previous = await fresh().findOneOrFail(OutboxMessageRecord, { aggregateId: target.id });
    const ids = [randomUUID(), randomUUID(), previous.id]; let failure: unknown;
    try { await new ProcessWagerTransaction(work(), new WagerTransactionIdentity(), { newId: () => ids.shift()!, now: () => new Date(), retryDelay: async () => {} }).execute(command(target)); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(UniqueConstraintViolationException); expect(failure).not.toBeInstanceOf(WagerIdentityCollisionError);
    await noWin(target, before);
  });
  test('reference reads use the callback transaction and observe its own uncommitted insert', async () => {
    const target = await open(); const candidate = new WagerTransactionIdentity().createCandidate(unreferenced(target, { kind: Kind.Bet }), randomUUID(), new Date());
    await expect(work().transaction(async scope => {
      await scope.lockWallet(target.id); await scope.insertPending(candidate);
      expect((await scope.findReference(candidate.providerId, candidate.externalTransactionId))!.id).toBe(candidate.id);
      expect(await fresh().findOne(WagerTransactionRecord, candidate.id)).toBeNull(); throw new Error('Rollback reference fixture');
    })).rejects.toThrow('Rollback reference fixture');
    expect(await fresh().findOne(WagerTransactionRecord, candidate.id)).toBeNull();
  });
  test('reference query requires the wallet lock and cannot escape its transaction', async () => {
    const target = await open(); let escaped: ((provider: string, external: string) => Promise<unknown>) | undefined;
    await expect(work().transaction(scope => scope.findReference('provider', 'reference'))).rejects.toThrow('after locking');
    await work().transaction(async scope => { await scope.lockWallet(target.id); escaped = scope.findReference; });
    await expect(escaped!('provider', 'reference')).rejects.toThrow('closed or failed');
  });
  test.each(['commit', 'rollback'])('WIN waits for the reference writer %s under the same wallet lock', async decision => {
    const target = await open(); const input = command(target); const locked = latch(); const release = latch(); const started = latch(); let backend = 0;
    const writer: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(async scope => {
      const result = await callback(scope); locked.resolve(); await release.promise;
      if (decision === 'rollback') throw new Error('Reference writer rollback'); return result;
    }) };
    const observed: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(scope => callback({ ...scope,
      lockWallet: async id => {
        const manager = TransactionContext.getEntityManager()!;
        const rows = await manager.getConnection().execute('SELECT pg_backend_pid() AS pid', [], 'all', manager.getTransactionContext());
        backend = rows[0].pid as number; started.resolve(); return scope.lockWallet(id);
      },
    })) };
    const bet = processor(writer).execute(unreferenced(target, { kind: Kind.Bet, externalTransactionId: input.referenceExternalTransactionId! })); void bet.catch(() => {});
    let win: ReturnType<ProcessWagerTransaction['execute']> | undefined;
    try {
      await Promise.race([locked.promise, bet.then(() => { throw new Error('Premature BET commit'); })]);
      win = processor(observed).execute(input); void win.catch(() => {});
      await Promise.race([started.promise, win.then(() => { throw new Error('Premature WIN result'); })]);
      await waitForLock(backend); release.resolve();
      if (decision === 'commit') await bet; else await expect(bet).rejects.toThrow('Reference writer rollback');
      const result = await win;
      expect(result.status).toBe(decision === 'commit' ? Status.Processed : Status.PendingReference);
      expect((await financialState(target)).balance).toBe('100.00');
      expect((await financialState(target)).version).toBe(decision === 'commit' ? 3 : 1);
      if (decision === 'rollback') await pending(target, input, result.transactionId);
    } finally { release.resolve(); await Promise.allSettled(win ? [bet, win] : [bet]); }
  });
});
