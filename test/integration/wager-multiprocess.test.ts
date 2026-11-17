import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join, extname } from 'node:path';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction, type ProcessWagerTransactionResult } from '../../src/modules/wagering/application/process-wager-transaction';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { WagerTransactionRecord } from '../../src/database/entities';
import { WagerRequestFingerprint } from '../../src/modules/wagering/application/wager-request-fingerprint';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { BunProcessClient, bounded } from '../helpers/bun-process-client';
import type { Outcome, Checkpoint } from '../helpers/wager-process-protocol';
import { testPersistence, openTestWallet, wagerCommand, walletPersistenceSnapshot, assertWalletLedger, type TestWallet } from '../helpers/postgres-wager-fixtures';

type Job = ReturnType<BunProcessClient['prepare']>;
const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
const script = join(__dirname, '../helpers/wager-process-worker' + extname(__filename));
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function financial(outcome: Outcome): ProcessWagerTransactionResult {
  expect(outcome.kind).toBe('result'); if (outcome.kind !== 'result') throw new Error('Expected a persisted financial result'); return outcome.value;
}
function backend(event: Checkpoint): number {
  if (!event.backendPid || event.pid === process.pid) throw new Error('Missing independent worker PostgreSQL evidence'); return event.backendPid;
}

describe.skipIf(!enabled)('Real three-process wagering concurrency (6.1–6.4)', () => {
  let orm: MikroORM;
  const work = () => new PostgresWagerProcessingUnitOfWork(orm);
  const processor = () => new ProcessWagerTransaction(work());
  beforeAll(async () => { orm = await testPersistence(); await orm.getMigrator().up(); }, 30000);
  afterAll(async () => { if (orm) await orm.close(true); });
  async function waitLocks(events: Checkpoint[]) {
    const pids = events.map(backend); const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const rows = await orm.em.fork().execute<{ pid: number; wait_event_type: string; application_name: string }[]>(
        `SELECT pid,wait_event_type,application_name FROM pg_stat_activity WHERE pid IN (${pids.map(() => '?').join(',')})`, pids);
      if (rows.length === pids.length && rows.every(row => row.wait_event_type === 'Lock')) {
        for (const event of events) expect(rows.find(row => row.pid === event.backendPid)!.application_name).toBe(`wager-process-${event.pid}`);
        return;
      }
      await Bun.sleep(10); // Poll a database condition; elapsed sleep never releases a race barrier.
    }
    throw new Error('Workers did not concurrently wait for PostgreSQL locks');
  }
  async function withWorkers(run: (workers: BunProcessClient[], replace: (index: number) => Promise<void>) => Promise<void>) {
    const workers: BunProcessClient[] = []; const all: BunProcessClient[] = [];
    const spawn = () => { const client = new BunProcessClient(script); all.push(client); return client; };
    try {
      for (let index = 0; index < 3; index++) workers.push(spawn());
      const ready = await Promise.all(workers.map(worker => worker.ready));
      expect(new Set(ready.map(item => item.pid)).size).toBe(3);
      expect(ready.every(item => item.pid !== process.pid && typeof item.backendPid === 'number')).toBe(true);
      expect(new Set(ready.map(item => item.backendPid)).size).toBe(3);
      const rows = await orm.em.fork().execute<{ pid: number; application_name: string }[]>(
        'SELECT pid,application_name FROM pg_stat_activity WHERE pid IN (?,?,?) AND datname=current_database()', ready.map(item => item.backendPid));
      expect(rows).toHaveLength(3);
      for (const item of ready) expect(rows.find(row => row.pid === item.backendPid)!.application_name).toBe(`wager-process-${item.pid}`);
      console.log(JSON.stringify({ evidence: 'independent-bun-and-postgres', parentPid: process.pid,
        processes: ready.map(item => ({ pid: item.pid, backendPid: item.backendPid })) }));
      await run(workers, async index => {
        const previous = workers[index]!; await previous.close(); const next = spawn(); workers[index] = next;
        const ready = await next.ready; expect(ready.pid).not.toBe(previous.child.pid); expect(ready.backendPid).toBeGreaterThan(0);
      });
    } finally {
      await Promise.all(all.map(worker => worker.close()));
      expect(all.every(worker => worker.child.exitCode !== null || worker.child.signalCode !== null)).toBe(true);
      // Verify the server reaped connections too, including SIGKILL/crash paths.
      if (all.length) {
        const names = all.map(worker => `wager-process-${worker.child.pid}`); const deadline = Date.now() + 3000;
        let remaining = -1;
        while (Date.now() < deadline) {
          const rows = await orm.em.fork().execute<{ pid: number }[]>(
            `SELECT pid FROM pg_stat_activity WHERE application_name IN (${names.map(() => '?').join(',')})`, names);
          remaining = rows.length; if (remaining === 0) break; await Bun.sleep(10);
        }
        expect(remaining).toBe(0);
      }
    }
  }
  async function race(wallet: TestWallet, jobs: Job[], witnesses: Job[]): Promise<Outcome[]> {
    const acquired = latch(); const release = latch();
    const holding = work().transaction(async scope => { await scope.lockWallet(wallet.id); acquired.resolve(); await release.promise; });
    void holding.catch(() => {});
    try {
      await bounded(Promise.race([acquired.promise, holding.then(() => { throw new Error('Premature gate unlock'); })]), 4000, 'wallet gate');
      await Promise.all(jobs.map(job => job.armed));
      for (const job of witnesses) job.run();
      const events = await Promise.all(witnesses.map(job => job.waitFor('before-lock')));
      for (const job of jobs) if (!witnesses.includes(job)) job.run();
      await Promise.all(jobs.map(job => job.started));
      await waitLocks(events); release.resolve();
      return await Promise.all(jobs.map(job => job.result));
    } finally { release.resolve(); await holding; }
  }
  test('50 identical BET requests across three processes debit once and survive process replacement', async () => {
    const target = await openTestWallet(orm); const input = wagerCommand(target);
    await withWorkers(async (workers, replace) => {
      const jobs = Array.from({ length: 50 }, (_, index) => workers[index % 3]!.prepare(input));
      const results = (await race(target, jobs, jobs.slice(0, 3))).map(financial);
      expect(results).toHaveLength(50); expect(results.every(result => result.status === Status.Processed && result.balance.amount === '75.00')).toBe(true);
      expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1); expect(results.filter(result => result.idempotentReplay)).toHaveLength(49);
      expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
      const first = results.find(result => !result.idempotentReplay)!; const stored = await walletPersistenceSnapshot(orm, target);
      expect(stored.wallet.version).toBe(2); expect(stored.ledger).toHaveLength(2); expect(stored.outbox).toHaveLength(4);
      expect(stored.transactions.find(tx => tx.id === first.transactionId)!.payloadHash).toBe(WagerRequestFingerprint.from(input).payloadHash);
      await processor().execute(wagerCommand(target, Kind.Win, { money: { amount: '10.00', currency: 'BRL' } }));
      const later = await walletPersistenceSnapshot(orm, target); await replace(2);
      const replay = workers[2]!.prepare(input); await replay.armed; replay.run();
      expect(financial(await replay.result)).toEqual({ ...first, idempotentReplay: true });
      expect(await walletPersistenceSnapshot(orm, target)).toEqual(later); await assertWalletLedger(orm, target, '85.00');
      console.log(JSON.stringify({ scenario: 'same-bet-50', requests: 50, processed: 1, replays: 49, transactionId: first.transactionId }));
    });
  }, 30000);
  test('payload and external-identity conflicts wait for the winning process without a second effect', async () => {
    const target = await openTestWallet(orm); const input = wagerCommand(target);
    await withWorkers(async workers => {
      const winner = workers[0]!.prepare(input, { pauseAt: 'before-commit' }); await winner.armed; winner.run(); await winner.waitFor('before-commit');
      const mismatch = workers[1]!.prepare({ ...input, money: { amount: '26.00', currency: 'BRL' } });
      const external = workers[2]!.prepare({ ...input, idempotencyKey: input.idempotencyKey + '-other' });
      await Promise.all([mismatch.armed, external.armed]); mismatch.run(); external.run();
      await waitLocks(await Promise.all([mismatch.waitFor('before-lock'), external.waitFor('before-lock')])); winner.release();
      expect(financial(await winner.result).status).toBe(Status.Processed);
      expect(await mismatch.result).toMatchObject({ kind: 'error', code: 'WAGER_IDENTITY_CONFLICT', reason: 'PAYLOAD_MISMATCH' });
      expect(await external.result).toMatchObject({ kind: 'error', code: 'WAGER_IDENTITY_CONFLICT', reason: 'EXTERNAL_ID_REUSED' });
      const stored = await walletPersistenceSnapshot(orm, target); expect(stored.transactions).toHaveLength(2); expect(stored.wallet.version).toBe(2);
      await assertWalletLedger(orm, target, '75.00');
    });
  }, 30000);
  test('cross-wallet UNIQUE conflict is recovered only after rollback, freeing the contender wallet', async () => {
    const one = await openTestWallet(orm); const two = await openTestWallet(orm); const input = wagerCommand(one);
    await withWorkers(async workers => {
      const winner = workers[0]!.prepare(input, { pauseAt: 'before-commit' }); await winner.armed; winner.run(); await winner.waitFor('before-commit');
      const conflict = workers[1]!.prepare({ ...input, walletId: two.id, playerId: two.playerId }); await conflict.armed; conflict.run();
      // It has locked a different wallet and is blocked inserting an uncommitted global key, not reading a prior committed row.
      await waitLocks([await conflict.waitFor('identity-insert')]);
      const valid = workers[2]!.prepare(wagerCommand(two)); await valid.armed; valid.run(); await waitLocks([await valid.waitFor('before-lock')]);
      winner.release(); expect(financial(await winner.result).status).toBe(Status.Processed);
      expect(await conflict.result).toMatchObject({ kind: 'error', code: 'WAGER_IDENTITY_CONFLICT', reason: 'PAYLOAD_MISMATCH' });
      expect(financial(await valid.result).status).toBe(Status.Processed);
      expect((await walletPersistenceSnapshot(orm, two)).transactions).toHaveLength(2);
      await assertWalletLedger(orm, one, '75.00'); await assertWalletLedger(orm, two, '75.00');
    });
  }, 30000);
  test('two simultaneous BETs of 80.00 against 100.00 yield one debit and final 20.00', async () => {
    const target = await openTestWallet(orm);
    await withWorkers(async workers => {
      const jobs = [workers[0]!.prepare(wagerCommand(target, Kind.Bet, { money: { amount: '80.00', currency: 'BRL' } })),
        workers[1]!.prepare(wagerCommand(target, Kind.Bet, { money: { amount: '80.00', currency: 'BRL' } }))];
      const results = (await race(target, jobs, jobs)).map(financial);
      expect(results.filter(result => result.status === Status.Processed)).toHaveLength(1);
      expect(results.filter(result => result.status === Status.Rejected && result.failureCode === FailureCode.InsufficientFunds)).toHaveLength(1);
      const stored = await walletPersistenceSnapshot(orm, target);
      expect(stored.ledger.filter(entry => entry.direction === 'DEBIT')).toHaveLength(1); expect(stored.wallet.version).toBe(2);
      await assertWalletLedger(orm, target, '20.00');
    });
  }, 30000);
  test('an unrelated wallet completes in the third process while two processes contend on another wallet', async () => {
    const target = await openTestWallet(orm); const other = await openTestWallet(orm);
    await withWorkers(async workers => {
      const held = workers[0]!.prepare(wagerCommand(target), { pauseAt: 'locked' }); await held.armed; held.run(); await held.waitFor('locked-pause');
      const blocked = workers[1]!.prepare(wagerCommand(target)); await blocked.armed; blocked.run(); await waitLocks([await blocked.waitFor('before-lock')]);
      const unrelated = workers[2]!.prepare(wagerCommand(other)); await unrelated.armed; unrelated.run();
      expect(financial(await bounded(unrelated.result, 4000, 'unrelated wallet progress')).status).toBe(Status.Processed);
      // The owner is still paused. Completion above cannot be explained by releasing a global gate.
      expect((await walletPersistenceSnapshot(orm, target)).wallet.balance).toBe('100.00'); held.release();
      expect(financial(await held.result).status).toBe(Status.Processed); expect(financial(await blocked.result).status).toBe(Status.Processed);
      await assertWalletLedger(orm, target, '50.00'); await assertWalletLedger(orm, other, '75.00');
    });
  }, 30000);
  test.each([Kind.Refund, Kind.Rollback])('three distinct %s attempts on one reference preserve per-type uniqueness', async kind => {
    const target = await openTestWallet(orm); const reference = wagerCommand(target, kind === Kind.Refund ? Kind.Bet : Kind.Win);
    await processor().execute(reference);
    if (kind === Kind.Rollback) await processor().execute(wagerCommand(target, Kind.Bet, { money: { amount: '100.00', currency: 'BRL' } }));
    await withWorkers(async workers => {
      const jobs = workers.map(worker => worker.prepare(wagerCommand(target, kind, { referenceExternalTransactionId: reference.externalTransactionId })));
      const results = (await race(target, jobs, jobs)).map(financial);
      expect(results.filter(result => result.status === Status.Processed)).toHaveLength(1);
      expect(results.filter(result => result.failureCode === FailureCode.AlreadyReversed)).toHaveLength(2);
      const stored = await walletPersistenceSnapshot(orm, target);
      expect(stored.transactions.filter(tx => tx.kind === kind && tx.status === Status.Processed)).toHaveLength(1);
      await assertWalletLedger(orm, target, kind === Kind.Refund ? '100.00' : '0.00');
    });
  }, 30000);
  test('concurrent REFUND and ROLLBACK on the same BET both remain allowed, with one REFUND winner', async () => {
    const target = await openTestWallet(orm); const bet = wagerCommand(target); await processor().execute(bet);
    await withWorkers(async workers => {
      const jobs = [workers[0]!.prepare(wagerCommand(target, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId })),
        workers[1]!.prepare(wagerCommand(target, Kind.Rollback, { referenceExternalTransactionId: bet.externalTransactionId })),
        workers[2]!.prepare(wagerCommand(target, Kind.Refund, { referenceExternalTransactionId: bet.externalTransactionId }))];
      const results = (await race(target, jobs, jobs)).map(financial);
      expect(results.filter(result => result.status === Status.Processed)).toHaveLength(2);
      expect(results.filter(result => result.failureCode === FailureCode.AlreadyReversed)).toHaveLength(1);
      const stored = await walletPersistenceSnapshot(orm, target); expect(stored.wallet.version).toBe(4); expect(stored.ledger).toHaveLength(4);
      expect(stored.transactions.filter(tx => tx.kind === Kind.Refund && tx.status === Status.Processed)).toHaveLength(1);
      expect(stored.transactions.filter(tx => tx.kind === Kind.Rollback && tx.status === Status.Processed)).toHaveLength(1);
      await assertWalletLedger(orm, target, '125.00');
    });
  }, 30000);
  test.each(['before-commit', 'after-commit'] as const)('worker crash %s preserves atomicity and permits cross-process retry exactly once', async phase => {
    const target = await openTestWallet(orm); const input = wagerCommand(target); const before = await walletPersistenceSnapshot(orm, target);
    await withWorkers(async (workers, replace) => {
      const owner = workers[0]!.prepare(input, { pauseAt: phase }); await owner.armed; owner.run(); const paused = await owner.waitFor(phase);
      expect(paused.transactionId).toBeTruthy();
      if (phase === 'before-commit') expect(await walletPersistenceSnapshot(orm, target)).toEqual(before);
      else await assertWalletLedger(orm, target, '75.00');
      const retries = [workers[1]!.prepare(input), workers[2]!.prepare(input)]; await Promise.all(retries.map(job => job.armed));
      if (phase === 'before-commit') { for (const job of retries) job.run(); await waitLocks(await Promise.all(retries.map(job => job.waitFor('before-lock')))); }
      await workers[0]!.kill(); await expect(owner.result).rejects.toThrow('exited');
      if (phase === 'after-commit') for (const job of retries) job.run();
      const results = (await Promise.all(retries.map(job => job.result))).map(financial);
      expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
      expect(results.filter(result => !result.idempotentReplay)).toHaveLength(phase === 'before-commit' ? 1 : 0);
      if (phase === 'before-commit') expect(await orm.em.fork().findOne(WagerTransactionRecord, paused.transactionId!)).toBeNull();
      else expect(results.every(result => result.transactionId === paused.transactionId)).toBe(true);
      await replace(0); const committed = await walletPersistenceSnapshot(orm, target); const replay = workers[0]!.prepare(input); await replay.armed; replay.run();
      expect(financial(await replay.result)).toEqual({ ...results[0]!, idempotentReplay: true });
      expect(await walletPersistenceSnapshot(orm, target)).toEqual(committed);
      expect(committed.transactions).toHaveLength(2); expect(committed.ledger).toHaveLength(2); expect(committed.outbox).toHaveLength(4);
      await assertWalletLedger(orm, target, '75.00');
    });
  }, 30000);
});
