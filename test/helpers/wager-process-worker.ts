import { createInterface } from 'node:readline';
import { TransactionContext } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseOptions } from '../../src/database/orm';
import { ProcessWagerTransaction } from '../../src/modules/wagering/application/process-wager-transaction';
import type { WagerProcessingUnitOfWork } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { assertPersistenceTestEnvironment } from '../integration/environment';
import { bounded } from './bun-process-client';
import { withWagerFault } from './wager-faults';
import type { ParentMessage, WorkerMessage } from './wager-process-protocol';

async function main(): Promise<void> {
  // Fail closed before initialization: this executable may never connect to the VPS or production.
  assertPersistenceTestEnvironment(process.env);
  const input = createInterface({ input: process.stdin });
  const orm = await MikroORM.init({ ...databaseOptions({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test', user: 'diagnostic', password: process.env.PGPASSWORD! }),
    driverOptions: { connection: { connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: `wager-process-${process.pid}` } },
  });
  const base = new PostgresWagerProcessingUnitOfWork(orm);
  const prepared = new Map<string, Extract<ParentMessage, { type: 'prepare' }>>();
  const gates = new Map<string, { release: () => void; abort: () => void }>();
  const running = new Set<Promise<void>>();
  let stopping: Promise<void> | undefined;
  function send(message: WorkerMessage) {
    if (stopping) return;
    try { process.stdout.write(JSON.stringify(message) + '\n'); } catch { void shutdown(); }
  }
  async function pause(id: string, phase: string, backendPid: number, transactionId?: string) {
    const gate = new Promise<void>((resolve, reject) => gates.set(id, { release: resolve, abort: () => reject(new Error('Worker stopping')) }));
    send({ type: 'checkpoint', id, phase, pid: process.pid, backendPid, ...(transactionId ? { transactionId } : {}) });
    try { await bounded(gate, 8000, 'worker pause'); } finally { gates.delete(id); }
  }
  async function execute(job: Extract<ParentMessage, { type: 'prepare' }>) {
    let backendPid = 0; let transactionId: string | undefined;
    const observed: WagerProcessingUnitOfWork = { transaction: callback => base.transaction(async scope => {
      const manager = TransactionContext.getEntityManager()!;
      const rows = await manager.getConnection().execute('SELECT pg_backend_pid() AS pid', [], 'all', manager.getTransactionContext());
      backendPid = rows[0].pid as number;
      const checkpoint = (phase: string) => send({ type: 'checkpoint', id: job.id, phase, pid: process.pid, backendPid,
        ...(transactionId ? { transactionId } : {}) });
      const result = await callback({ ...scope,
        lockWallet: async id => {
          checkpoint('before-lock'); const wallet = await scope.lockWallet(id); checkpoint('locked');
          if (job.options.pauseAt === 'locked') await pause(job.id, 'locked-pause', backendPid); return wallet;
        },
        insertPending: async tx => { transactionId = tx.id; checkpoint('identity-insert'); await scope.insertPending(tx); },
      });
      if (job.options.pauseAt === 'before-commit') await pause(job.id, 'before-commit', backendPid, transactionId);
      return result;
    }) };
    try {
      const work = job.options.failAt ? withWagerFault(observed, job.options.failAt) : observed;
      const value = await new ProcessWagerTransaction(work).execute(job.command);
      if (job.options.pauseAt === 'after-commit') await pause(job.id, 'after-commit', backendPid, value.transactionId);
      send({ type: 'outcome', id: job.id, outcome: { kind: 'result', value } });
    } catch (error) {
      // Never serialize SQL, credentials, driver messages or arbitrary exception objects over IPC.
      send({ type: 'outcome', id: job.id, outcome: { kind: 'error', name: error instanceof Error ? error.name : 'UnknownError',
        ...(error instanceof Error && 'code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
        ...(error instanceof Error && 'reason' in error && typeof error.reason === 'string' ? { reason: error.reason } : {}),
      } });
    }
  }
  function shutdown(): Promise<void> {
    if (!stopping) stopping = (async () => {
      for (const gate of gates.values()) gate.abort(); prepared.clear();
      await Promise.allSettled([...running]); await orm.close(true);
      input.close(); process.stdin.destroy();
    })();
    return stopping;
  }
  input.on('line', line => {
    const message = JSON.parse(line) as ParentMessage;
    if (message.type === 'stop') { void shutdown(); return; }
    if (stopping) return;
    if (message.type === 'release') { gates.get(message.id)?.release(); return; }
    if (message.type === 'prepare') {
      if (prepared.has(message.id)) { void shutdown(); return; }
      prepared.set(message.id, message); send({ type: 'armed', id: message.id }); return;
    }
    const job = prepared.get(message.id);
    if (!job) { void shutdown(); return; }
    prepared.delete(message.id); send({ type: 'running', id: message.id });
    const task = execute(job); running.add(task); void task.finally(() => running.delete(task));
  });
  input.on('close', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  const [row] = await orm.em.fork().execute<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
  send({ type: 'ready', pid: process.pid, backendPid: row!.pid });
}
void main().catch(() => { process.stdout.write(JSON.stringify({ type: 'fatal' }) + '\n'); process.stdin.destroy(); process.exitCode = 1; });
