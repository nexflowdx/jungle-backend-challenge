import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { TransactionContext, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createPersistence } from '../../src/database/orm';
import { WalletRecord, WagerTransactionRecord, LedgerEntryRecord, OutboxMessageRecord } from '../../src/database/entities';
import { rehydrateMoney } from '../../src/database/money-mapping';
import { transactionMapper } from '../../src/database/domain-mappers';
import { Money } from '../../src/shared/domain/money';
import { OpenWallet } from '../../src/modules/wallets/application/open-wallet';
import { PostgresWalletOpeningUnitOfWork } from '../../src/modules/wallets/infrastructure/postgres-wallet-opening-unit-of-work';
import { ProcessWagerTransaction, type SupportedWagerCommand } from '../../src/modules/wagering/application/process-wager-transaction';
import type { WagerProcessingUnitOfWork, WagerProcessingTransaction } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { WagerTransactionIdentity, WagerIdentityCollisionError } from '../../src/modules/wagering/application/wager-transaction-identity';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { assertPersistenceTestEnvironment } from './environment';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
type Target = { id: string; playerId: string; balance: { amount: string; currency: string } };
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe.skipIf(!enabled)('Atomic REFUND and ROLLBACK PostgreSQL integration (5.6)', () => {
  let orm: MikroORM;
  const connection = () => ({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test', user: 'diagnostic', password: process.env.PGPASSWORD! });
  const fresh = () => orm.em.fork();
  const work = () => new PostgresWagerProcessingUnitOfWork(orm);
  const processor = (scope: WagerProcessingUnitOfWork = work()) => new ProcessWagerTransaction(scope);
  const open = (amount = '100.00', currency = 'BRL') => new OpenWallet(new PostgresWalletOpeningUnitOfWork(orm))
    .execute({ playerId: randomUUID(), initialBalance: { amount, currency }, correlationId: randomUUID() });
  const command = (target: Target, kind: SupportedWagerCommand['kind'], overrides: Partial<SupportedWagerCommand> = {}): SupportedWagerCommand => ({
    kind, walletId: target.id, playerId: target.playerId, idempotencyKey: randomUUID(), providerId: 'provider',
    externalTransactionId: randomUUID(), gameId: 'game', roundId: 'round', money: { amount: '25.00', currency: target.balance.currency },
    correlationId: randomUUID(), causationId: randomUUID(),
    ...(kind === Kind.Refund || kind === Kind.Rollback ? { referenceExternalTransactionId: randomUUID() } : {}), ...overrides,
  });
  async function seed(target: Target, kind: SupportedWagerCommand['kind'] = Kind.Bet) {
    let input = command(target, kind);
    if (kind === Kind.Refund || kind === Kind.Rollback) {
      const bet = command(target, Kind.Bet); await processor().execute(bet);
      input = command(target, kind, { referenceExternalTransactionId: bet.externalTransactionId });
    }
    const result = await processor().execute(input); expect(result.status).toBe(Status.Processed); return { input, result };
  }
  const reverse = (target: Target, kind: Kind.Refund | Kind.Rollback, reference: SupportedWagerCommand, overrides: Partial<SupportedWagerCommand> = {}) =>
    command(target, kind, { referenceExternalTransactionId: reference.externalTransactionId, money: reference.money, ...overrides });
  async function state(target: Target) {
    const row = await fresh().findOneOrFail(WalletRecord, target.id);
    return { balance: row.balance, version: row.version, updatedAt: row.updatedAt,
      ledger: await fresh().count(LedgerEntryRecord, { walletId: target.id }) };
  }
  async function artifacts(target: Target) {
    return { ...await state(target), transactions: await fresh().count(WagerTransactionRecord, { walletId: target.id }),
      events: await fresh().count(OutboxMessageRecord, { aggregateId: target.id }) };
  }
  const outbox = async (target: Target, id: string) => (await fresh().find(OutboxMessageRecord, { aggregateId: target.id }))
    .filter(event => (event.payload.data as { transactionId: string }).transactionId === id);
  async function consistent(target: Target) {
    const [row] = await fresh().execute<{ balance: string; reconstructed: string }[]>(`SELECT w.balance,
      COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0) AS reconstructed
      FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id=w.id WHERE w.id=? GROUP BY w.id`, [target.id]);
    expect(rehydrateMoney(row!.balance, target.balance.currency)
      .equals(rehydrateMoney(row!.reconstructed, target.balance.currency))).toBe(true);
  }
  async function effects(target: Target, input: SupportedWagerCommand, id: string, status: Status, direction?: 'CREDIT' | 'DEBIT') {
    const tx = await fresh().findOneOrFail(WagerTransactionRecord, id); expect(tx.status).toBe(status);
    const ledger = await fresh().find(LedgerEntryRecord, { transactionId: id });
    expect(ledger).toHaveLength(direction ? 1 : 0);
    if (ledger[0]) expect(ledger[0]).toMatchObject({ direction, amount: tx.amount, currency: tx.currency, balanceAfter: tx.balance });
    const events = await outbox(target, id);
    expect(events.map(event => event.eventType).sort()).toEqual((status === Status.PendingReference ? ['WagerTransactionPendingReference']
      : status === Status.Rejected ? ['WagerTransactionRejected'] : ['WagerTransactionProcessed', 'WalletBalanceChanged']).sort());
    for (const event of events) {
      expect(event.publishedAt).toBeNull(); expect(event.payload).toMatchObject({ correlationId: input.correlationId, causationId: input.causationId });
    }
    if (status === Status.PendingReference) expect(tx).toMatchObject({ acceptedCurrency: target.balance.currency, balance: null, completedAt: null, referenceTransactionId: null });
    else expect(tx.completedAt).toBeInstanceOf(Date);
    await consistent(target);
  }
  function failAfter(point: string): WagerProcessingUnitOfWork {
    const fail = (name: string) => { if (point === name) throw new Error(`Injected ${point}`); };
    return { transaction: callback => work().transaction(async scope => {
      const result = await callback({ ...scope,
        insertPending: async tx => { await scope.insertPending(tx); fail('identity'); },
        findProcessedReversals: async id => { const rows = await scope.findProcessedReversals(id); fail('reversals'); return rows; },
        saveWallet: async wallet => { await scope.saveWallet(wallet); fail('wallet'); },
        completeTransaction: async tx => { await scope.completeTransaction(tx); fail('result'); },
        insertLedgerEntry: async entry => { await scope.insertLedgerEntry(entry); fail('ledger'); },
        insertEvents: async events => { await scope.insertEvents(events); fail('outbox'); },
      }); fail('commit'); return result;
    }) };
  }
  async function fixture(target: Target, status: Status.Pending | Status.PendingReference | Status.Failed) {
    const input = command(target, Kind.Bet, status === Status.PendingReference ? { referenceExternalTransactionId: randomUUID() } : {});
    const reference = new WagerTransactionIdentity().createCandidate(input, randomUUID(), new Date());
    if (status === Status.PendingReference) reference.markPendingReference(Money.from(target.balance));
    if (status === Status.Failed) reference.fail(FailureCode.PermanentInfrastructureFailure, Money.from(target.balance), new Date());
    await fresh().transactional(manager => manager.persistAndFlush(transactionMapper.toRecord(reference))); return input;
  }
  async function waitForLock(pid: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [row] = await fresh().execute<{ wait_event_type: string | null }[]>('SELECT wait_event_type FROM pg_stat_activity WHERE pid=?', [pid]);
      if (row?.wait_event_type === 'Lock') return;
      await Bun.sleep(10);
    }
    throw new Error('Expected reversal contender to wait for the wallet lock');
  }
  beforeAll(async () => { assertPersistenceTestEnvironment(process.env); orm = await createPersistence(connection()); await orm.getMigrator().up(); }, 30000);
  afterAll(async () => { if (orm) await orm.close(true); });

  test.each([
    ['100.00', '25.00', 'BRL'], ['100.00', '25.00', 'USD'], ['1.00', '0.01', 'BRL'],
    ['9007199254740993.01', '9007199254740993.00', 'USD'], ['92233720368547758.07', '92233720368547758.07', 'BRL'],
  ])('REFUND restores exact balance %s after full BET %s %s', async (initial, amount, currency) => {
    const target = await open(initial!, currency!); const bet = command(target, Kind.Bet, { money: { amount: amount!, currency: currency! } });
    const reference = await processor().execute(bet); const input = reverse(target, Kind.Refund, bet); const result = await processor().execute(input);
    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: initial, currency } });
    expect((await state(target)).version).toBe(3);
    expect((await fresh().findOneOrFail(WagerTransactionRecord, result.transactionId)).referenceTransactionId).toBe(reference.transactionId);
    await effects(target, input, result.transactionId, Status.Processed, 'CREDIT');
  });
  test.each([[Kind.Bet, 'BRL'], [Kind.Win, 'BRL'], [Kind.Refund, 'BRL'], [Kind.Bet, 'USD'], [Kind.Win, 'USD'], [Kind.Refund, 'USD']] as const)(
    'ROLLBACK inverts %s in %s', async (kind, currency) => {
      const target = await open('100.00', currency); const reference = await seed(target, kind); const before = await state(target);
      const input = reverse(target, Kind.Rollback, reference.input); const result = await processor().execute(input);
      expect(result).toMatchObject({ status: Status.Processed, balance: { amount: kind === Kind.Refund ? '75.00' : '100.00', currency } });
      expect((await state(target)).version).toBe(before.version + 1);
      expect((await fresh().findOneOrFail(WagerTransactionRecord, result.transactionId)).referenceTransactionId).toBe(reference.result.transactionId);
      await effects(target, input, result.transactionId, Status.Processed, kind === Kind.Bet ? 'CREDIT' : 'DEBIT');
    },
  );
  test.each([Kind.Refund, Kind.Rollback])('%s replay after later BET and client restart preserves the original result', async kind => {
    const target = await open(); const reference = await seed(target); const input = reverse(target, kind, reference.input); const first = await processor().execute(input);
    await processor().execute(command(target, Kind.Bet, { money: { amount: '10.00', currency: 'BRL' } })); const before = await artifacts(target);
    const restarted = await createPersistence(connection());
    try { expect(await new ProcessWagerTransaction(new PostgresWagerProcessingUnitOfWork(restarted)).execute(input)).toEqual({ ...first, idempotentReplay: true }); }
    finally { await restarted.close(true); }
    expect(await artifacts(target)).toEqual(before); await consistent(target);
  });
  test.each([Kind.Refund, Kind.Rollback])('distinct second %s is rejected while the first remains replayable', async kind => {
    const target = await open(); const reference = await seed(target); const input = reverse(target, kind, reference.input); const first = await processor().execute(input);
    const before = await state(target); const second = reverse(target, kind, reference.input); const rejected = await processor().execute(second);
    expect(rejected).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.AlreadyReversed }); expect(await state(target)).toEqual(before);
    await effects(target, second, rejected.transactionId, Status.Rejected);
    const stored = await artifacts(target);
    expect(await processor().execute(input)).toEqual({ ...first, idempotentReplay: true });
    expect(await processor().execute(second)).toEqual({ ...rejected, idempotentReplay: true }); expect(await artifacts(target)).toEqual(stored);
  });
  test.each([[Kind.Refund, Kind.Rollback], [Kind.Rollback, Kind.Refund]] as const)('policy permits %s and %s on the same BET', async (first, second) => {
    const target = await open('200.00'); const bet = command(target, Kind.Bet, { money: { amount: '100.00', currency: 'BRL' } }); await processor().execute(bet);
    const one = reverse(target, first, bet); const two = reverse(target, second, bet);
    expect((await processor().execute(one)).status).toBe(Status.Processed); const result = await processor().execute(two);
    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: '300.00' } }); expect((await state(target)).version).toBe(4); await consistent(target);
  });
  test.each([Kind.Win, Kind.Refund])('debit ROLLBACK of %s rejects insufficient funds and allows a later valid reversal', async kind => {
    const target = await open(); const reference = await seed(target, kind);
    await processor().execute(command(target, Kind.Bet, { money: { amount: (await state(target)).balance, currency: 'BRL' } }));
    const input = reverse(target, Kind.Rollback, reference.input); const before = await state(target); const first = await processor().execute(input);
    expect(first).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReversalInsufficientFunds, balance: { amount: '0.00' } });
    expect(await state(target)).toEqual(before); await effects(target, input, first.transactionId, Status.Rejected);
    await processor().execute(command(target, Kind.Win)); const funded = await artifacts(target);
    expect(await processor().execute(input)).toEqual({ ...first, idempotentReplay: true }); expect(await artifacts(target)).toEqual(funded);
    const second = reverse(target, Kind.Rollback, reference.input); const valid = await processor().execute(second);
    expect(valid.status).toBe(Status.Processed); expect((await state(target)).balance).toBe('0.00'); await effects(target, second, valid.transactionId, Status.Processed, 'DEBIT');
  });
  test.each([Kind.Refund, Kind.Rollback])('%s amount mismatch rejects without consuming the reversal', async kind => {
    const target = await open(); const reference = await seed(target); const before = await state(target);
    const bad = reverse(target, kind, reference.input, { money: { amount: '24.99', currency: 'BRL' } }); const result = await processor().execute(bad);
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceAmountMismatch }); expect(await state(target)).toEqual(before);
    await effects(target, bad, result.transactionId, Status.Rejected);
    expect((await processor().execute(reverse(target, kind, reference.input))).status).toBe(Status.Processed); await consistent(target);
  });
  test.each([
    [Kind.Refund, 'absent'], [Kind.Rollback, 'absent'], [Kind.Refund, 'pending'], [Kind.Rollback, 'pending'],
    [Kind.Refund, 'pending-reference'], [Kind.Rollback, 'pending-reference'],
  ] as const)('%s with %s reference accepts and replays a durable pending snapshot', async (kind, status) => {
    const target = await open(); const input = status === 'absent' ? command(target, kind) : reverse(target, kind,
      await fixture(target, status === 'pending' ? Status.Pending : Status.PendingReference));
    const before = await state(target); const first = await processor().execute(input);
    expect(first).toMatchObject({ status: Status.PendingReference, balance: target.balance }); expect(await state(target)).toEqual(before);
    await effects(target, input, first.transactionId, Status.PendingReference);
    await processor().execute(command(target, Kind.Bet)); const moved = await artifacts(target);
    expect(await processor().execute(input)).toEqual({ ...first, idempotentReplay: true }); expect(await artifacts(target)).toEqual(moved);
  });
  test.each([Kind.Refund, Kind.Rollback])('%s pending replay stays pending after its BET arrives', async kind => {
    const target = await open(); const input = command(target, kind); const first = await processor().execute(input);
    await processor().execute(command(target, Kind.Bet, { externalTransactionId: input.referenceExternalTransactionId! })); const before = await artifacts(target);
    expect(await processor().execute(input)).toEqual({ ...first, idempotentReplay: true }); expect(await artifacts(target)).toEqual(before);
  });
  test.each([
    [Kind.Refund, 'round'], [Kind.Rollback, 'round'], [Kind.Refund, 'currency'], [Kind.Rollback, 'currency'],
    [Kind.Refund, 'wallet'], [Kind.Rollback, 'wallet'], [Kind.Refund, 'rejected'], [Kind.Rollback, 'rejected'],
    [Kind.Refund, 'failed'], [Kind.Rollback, 'failed'], [Kind.Refund, 'self'], [Kind.Rollback, 'self'],
  ] as const)('%s rejects invalid reference %s without movement', async (kind, reason) => {
    const target = await open(); let reference: SupportedWagerCommand;
    if (reason === 'failed') reference = await fixture(target, Status.Failed);
    else {
      const owner = reason === 'wallet' ? await open() : target;
      reference = command(owner, Kind.Bet, { ...(reason === 'round' ? { roundId: 'different' } : {}),
        money: { amount: reason === 'rejected' ? '101.00' : '25.00', currency: reason === 'currency' ? 'USD' : 'BRL' } });
      await processor().execute(reference);
    }
    const input = reverse(target, kind, reference, { money: { amount: '25.00', currency: 'BRL' } });
    const finalInput = reason === 'self' ? { ...input, referenceExternalTransactionId: input.externalTransactionId } : input;
    const before = await state(target); const result = await processor().execute(finalInput);
    const codes = { round: FailureCode.ReferenceContextMismatch, currency: FailureCode.ReferenceContextMismatch, wallet: FailureCode.ReferenceContextMismatch,
      rejected: FailureCode.ReferenceRejected, failed: FailureCode.ReferenceFailed, self: FailureCode.SelfReference };
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: codes[reason] }); expect(await state(target)).toEqual(before);
    await effects(target, finalInput, result.transactionId, Status.Rejected);
  });
  test.each([[Kind.Refund, Kind.Win], [Kind.Refund, Kind.Refund], [Kind.Refund, Kind.Loss], [Kind.Refund, Kind.Rollback], [Kind.Rollback, Kind.Loss], [Kind.Rollback, Kind.Rollback]] as const)(
    '%s rejects reference kind %s', async (kind, referenceKind) => {
      const target = await open(); const reference = await seed(target, referenceKind); const before = await state(target);
      const input = reverse(target, kind, reference.input); const result = await processor().execute(input);
      expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceKindInvalid }); expect(await state(target)).toEqual(before);
      await effects(target, input, result.transactionId, Status.Rejected);
    },
  );
  test.each([Kind.Refund, Kind.Rollback])('%s scopes reference lookup to the provider', async kind => {
    const target = await open(); const ref = command(target, Kind.Bet, { providerId: 'other-provider' }); await processor().execute(ref);
    const input = reverse(target, kind, ref); const before = await state(target); const result = await processor().execute(input);
    expect(result.status).toBe(Status.PendingReference); expect(await state(target)).toEqual(before); await effects(target, input, result.transactionId, Status.PendingReference);
  });
  test.each([Kind.Refund, Kind.Rollback])('%s identity conflicts preserve the persisted result without extra effects', async kind => {
    const target = await open(); const reference = await seed(target); const input = reverse(target, kind, reference.input); await processor().execute(input);
    const before = await artifacts(target);
    await expect(processor().execute({ ...input, money: { amount: '24.99', currency: 'BRL' } })).rejects.toMatchObject({ reason: 'PAYLOAD_MISMATCH' });
    await expect(processor().execute({ ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ reason: 'EXTERNAL_ID_REUSED' });
    expect(await artifacts(target)).toEqual(before);
  });
  test.each([Kind.Refund, Kind.Rollback])('ten distinct concurrent %s attempts have exactly one processed reversal', async kind => {
    const target = await open(); const reference = await seed(target);
    const inputs = Array.from({ length: 10 }, () => reverse(target, kind, reference.input));
    const results = await Promise.all(inputs.map(input => processor().execute(input)));
    expect(results.filter(result => result.status === Status.Processed)).toHaveLength(1);
    expect(results.filter(result => result.failureCode === FailureCode.AlreadyReversed)).toHaveLength(9);
    expect((await state(target))).toMatchObject({ balance: '100.00', version: 3, ledger: 3 });
    for (const [index, result] of results.entries()) await effects(target, inputs[index]!, result.transactionId, result.status, result.status === Status.Processed ? 'CREDIT' : undefined);
  });
  test.each([Kind.Refund, Kind.Rollback])('ten identical concurrent %s retries have one financial effect', async kind => {
    const target = await open(); const reference = await seed(target); const input = reverse(target, kind, reference.input);
    const results = await Promise.all(Array.from({ length: 10 }, () => processor().execute(input)));
    expect(new Set(results.map(result => result.transactionId)).size).toBe(1); expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
    expect((await state(target))).toMatchObject({ balance: '100.00', version: 3, ledger: 3 }); await effects(target, input, results[0]!.transactionId, Status.Processed, 'CREDIT');
  });
  test('concurrent REFUND and ROLLBACK of one BET both commit under the documented policy', async () => {
    const target = await open(); const reference = await seed(target);
    const inputs = [reverse(target, Kind.Refund, reference.input), reverse(target, Kind.Rollback, reference.input)];
    const results = await Promise.all(inputs.map(input => processor().execute(input)));
    expect(results.map(result => result.status)).toEqual([Status.Processed, Status.Processed]);
    expect((await state(target))).toMatchObject({ balance: '125.00', version: 4, ledger: 4 }); await consistent(target);
  });
  test.each([
    [Kind.Refund, 'identity'], [Kind.Refund, 'reversals'], [Kind.Refund, 'wallet'], [Kind.Refund, 'result'], [Kind.Refund, 'ledger'], [Kind.Refund, 'outbox'], [Kind.Refund, 'commit'],
    [Kind.Rollback, 'identity'], [Kind.Rollback, 'reversals'], [Kind.Rollback, 'wallet'], [Kind.Rollback, 'result'], [Kind.Rollback, 'ledger'], [Kind.Rollback, 'outbox'], [Kind.Rollback, 'commit'],
  ] as const)('%s failure after %s rolls back the full financial result and identity', async (kind, point) => {
    const target = await open(); const reference = await seed(target, kind === Kind.Rollback ? Kind.Win : Kind.Bet);
    const input = reverse(target, kind, reference.input); const before = await artifacts(target);
    await expect(processor(failAfter(point)).execute(input)).rejects.toThrow(`Injected ${point}`); expect(await artifacts(target)).toEqual(before);
    const result = await processor().execute(input); expect(result).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    await effects(target, input, result.transactionId, Status.Processed, kind === Kind.Rollback ? 'DEBIT' : 'CREDIT');
  });
  test.each([Kind.Refund, Kind.Rollback])('PostgreSQL UNIQUE independently prevents a second %s and rolls back the attempted write', async kind => {
    const target = await open(); const reference = await seed(target); await processor().execute(reverse(target, kind, reference.input));
    const before = await artifacts(target);
    const bypass: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(scope => callback({ ...scope, findProcessedReversals: async () => [] })) };
    let failure: unknown;
    try { await processor(bypass).execute(reverse(target, kind, reference.input)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(UniqueConstraintViolationException); expect(failure).toMatchObject({ code: '23505', constraint: 'transactions_processed_reversal_unique' });
    expect(failure).not.toBeInstanceOf(WagerIdentityCollisionError); expect(await artifacts(target)).toEqual(before);
    expect((await processor().execute(reverse(target, kind, reference.input))).failureCode).toBe(FailureCode.AlreadyReversed);
  });
  test('processed reversal reads share the transaction and roll back their own uncommitted writes', async () => {
    const target = await open(); const reference = await seed(target); const before = await artifacts(target);
    const candidate = new WagerTransactionIdentity().createCandidate(reverse(target, Kind.Refund, reference.input), randomUUID(), new Date());
    await expect(work().transaction(async scope => {
      const wallet = (await scope.lockWallet(target.id))!; const tx = (await scope.findReference(reference.input.providerId, reference.input.externalTransactionId))!;
      await scope.insertPending(candidate);
      const entry = candidate.process(wallet, { reference: tx, priorReversals: [], at: new Date(), ledgerEntryId: randomUUID() })!;
      await scope.saveWallet(wallet); await scope.completeTransaction(candidate); await scope.insertLedgerEntry(entry);
      expect((await scope.findProcessedReversals(tx.id)).map(row => row.id)).toEqual([candidate.id]);
      expect(await fresh().findOne(WagerTransactionRecord, candidate.id)).toBeNull(); throw new Error('Rollback own reversal');
    })).rejects.toThrow('Rollback own reversal'); expect(await artifacts(target)).toEqual(before);
  });
  test('reversal query requires the wallet lock and expires with its scope', async () => {
    let escaped!: WagerProcessingTransaction['findProcessedReversals'];
    await expect(work().transaction(scope => scope.findProcessedReversals('reference'))).rejects.toThrow('after locking');
    const target = await open(); await work().transaction(async scope => { await scope.lockWallet(target.id); escaped = scope.findProcessedReversals; });
    await expect(escaped('reference')).rejects.toThrow('closed or failed');
  });
  test.each(['commit', 'rollback'])('concurrent reversal observes the first writer %s after waiting for its wallet lock', async decision => {
    const target = await open(); const reference = await seed(target); const locked = latch(); const release = latch(); const started = latch(); let backend = 0;
    const held: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(async scope => {
      const result = await callback(scope); locked.resolve(); await release.promise; if (decision === 'rollback') throw new Error('First reversal rollback'); return result;
    }) };
    const observed: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(scope => callback({ ...scope,
      lockWallet: async id => { const manager = TransactionContext.getEntityManager()!;
        const rows = await manager.getConnection().execute('SELECT pg_backend_pid() AS pid', [], 'all', manager.getTransactionContext());
        backend = rows[0].pid as number; started.resolve(); return scope.lockWallet(id); },
    })) };
    const first = processor(held).execute(reverse(target, Kind.Refund, reference.input)); void first.catch(() => {});
    let second: ReturnType<ProcessWagerTransaction['execute']> | undefined;
    try {
      await Promise.race([locked.promise, first.then(() => { throw new Error('Premature first result'); })]);
      second = processor(observed).execute(reverse(target, Kind.Refund, reference.input)); void second.catch(() => {});
      await Promise.race([started.promise, second.then(() => { throw new Error('Premature second result'); })]);
      await waitForLock(backend); release.resolve();
      if (decision === 'commit') await first; else await expect(first).rejects.toThrow('First reversal rollback');
      const result = await second; expect(result.status).toBe(decision === 'commit' ? Status.Rejected : Status.Processed);
      if (decision === 'commit') expect(result.failureCode).toBe(FailureCode.AlreadyReversed);
    } finally { release.resolve(); await Promise.allSettled(second ? [first, second] : [first]); }
    expect((await state(target))).toMatchObject({ balance: '100.00', version: 3, ledger: 3 }); await consistent(target);
  });
  test.each([Kind.Win, Kind.Refund])('concurrent debit ROLLBACKs of the same %s debit exactly once', async kind => {
    const target = await open(); const reference = await seed(target, kind); const before = await state(target);
    const inputs = Array.from({ length: 10 }, () => reverse(target, Kind.Rollback, reference.input));
    const results = await Promise.all(inputs.map(input => processor().execute(input)));
    expect(results.filter(result => result.status === Status.Processed)).toHaveLength(1);
    expect(results.filter(result => result.failureCode === FailureCode.AlreadyReversed)).toHaveLength(9);
    expect(await state(target)).toMatchObject({ balance: kind === Kind.Win ? '100.00' : '75.00', version: before.version + 1, ledger: before.ledger + 1 });
    for (const [index, result] of results.entries()) await effects(target, inputs[index]!, result.transactionId, result.status, result.status === Status.Processed ? 'DEBIT' : undefined);
  });
  test('debit reversals of distinct WINs compete for available funds without overdraft', async () => {
    const target = await open('0.00'); const one = await seed(target, Kind.Win); const two = await seed(target, Kind.Win);
    await processor().execute(command(target, Kind.Bet)); const before = await state(target);
    const inputs = [reverse(target, Kind.Rollback, one.input), reverse(target, Kind.Rollback, two.input)];
    const results = await Promise.all(inputs.map(input => processor().execute(input)));
    expect(results.filter(result => result.status === Status.Processed)).toHaveLength(1);
    expect(results.filter(result => result.failureCode === FailureCode.ReversalInsufficientFunds)).toHaveLength(1);
    expect(await state(target)).toMatchObject({ balance: '0.00', version: before.version + 1, ledger: before.ledger + 1 });
    for (const [index, result] of results.entries()) await effects(target, inputs[index]!, result.transactionId, result.status, result.status === Status.Processed ? 'DEBIT' : undefined);
  });
  test('one wallet can refund while another wallet is locked', async () => {
    const blocked = await open(); const target = await open(); const reference = await seed(target);
    const reached = latch(); const release = latch();
    const holding = work().transaction(async scope => { await scope.lockWallet(blocked.id); reached.resolve(); await release.promise; }); void holding.catch(() => {});
    let running: ReturnType<ProcessWagerTransaction['execute']> | undefined;
    try {
      await Promise.race([reached.promise, holding.then(() => { throw new Error('Premature unlock'); })]);
      running = processor().execute(reverse(target, Kind.Refund, reference.input));
      expect((await Promise.race([running, Bun.sleep(3000).then(() => { throw new Error('Global reversal lock'); })])).status).toBe(Status.Processed);
    } finally { release.resolve(); await Promise.allSettled(running ? [holding, running] : [holding]); }
    expect((await state(blocked))).toMatchObject({ balance: '100.00', version: 1 }); await consistent(target);
  });
  test.each([Kind.Refund, Kind.Rollback])('%s credit overflow rejects and preserves a future valid reversal', async kind => {
    const target = await open('92233720368547758.07'); const reference = await seed(target);
    await processor().execute(command(target, Kind.Win)); const before = await state(target);
    const input = reverse(target, kind, reference.input); const first = await processor().execute(input);
    expect(first).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.AmountLimitExceeded }); expect(await state(target)).toEqual(before);
    await effects(target, input, first.transactionId, Status.Rejected);
    await processor().execute(command(target, Kind.Bet));
    const second = reverse(target, kind, reference.input); const result = await processor().execute(second);
    expect(result).toMatchObject({ status: Status.Processed, balance: target.balance }); await effects(target, second, result.transactionId, Status.Processed, 'CREDIT');
  });
  test.each([Kind.Refund, Kind.Rollback])('%s SQL reversal-read failure propagates without a pending fallback', async kind => {
    const target = await open(); const reference = await seed(target); const before = await artifacts(target);
    const broken: WagerProcessingUnitOfWork = { transaction: callback => work().transaction(scope => callback({ ...scope,
      findProcessedReversals: async () => {
        const manager = TransactionContext.getEntityManager()!;
        await manager.getConnection().execute('SELECT 1/0', [], 'all', manager.getTransactionContext()); return [];
      },
    })) };
    await expect(processor(broken).execute(reverse(target, kind, reference.input))).rejects.toMatchObject({ code: '22012' });
    expect(await artifacts(target)).toEqual(before);
  });
  test.each([Kind.Refund, Kind.Rollback])('%s pending outbox failure rolls back acceptance and identity', async kind => {
    const target = await open(); const before = await artifacts(target);
    await expect(processor(failAfter('outbox')).execute(command(target, kind))).rejects.toThrow('Injected outbox');
    expect(await artifacts(target)).toEqual(before);
  });
  test.each([Kind.Win, Kind.Refund])('ROLLBACK of %s preserves exact balances beyond the number precision limit', async kind => {
    const target = await open('9007199254740993.01', 'USD'); const reference = await seed(target, kind);
    const input = reverse(target, Kind.Rollback, reference.input); const result = await processor().execute(input);
    const expected = kind === Kind.Win ? target.balance : Money.from(target.balance).subtract(Money.from(reference.input.money)).toJSON();
    expect(result).toMatchObject({ status: Status.Processed, balance: expected }); await effects(target, input, result.transactionId, Status.Processed, 'DEBIT');
  });
  test.each([Kind.Refund, Kind.Rollback])('%s cannot reverse internal OPENING', async kind => {
    const target = await open(); const opening = await fresh().findOneOrFail(WagerTransactionRecord, { walletId: target.id, kind: Kind.Opening });
    const input = command(target, kind, { referenceExternalTransactionId: opening.externalTransactionId, providerId: opening.providerId,
      roundId: opening.roundId, money: { amount: opening.amount, currency: opening.currency } });
    const before = await state(target); const result = await processor().execute(input);
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.ReferenceKindInvalid });
    expect(await state(target)).toEqual(before); await effects(target, input, result.transactionId, Status.Rejected);
  });

});
