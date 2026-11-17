import { expect, test } from 'bun:test';
import { join, extname } from 'node:path';
import { BunProcessClient } from '../helpers/bun-process-client';
import { WagerTransactionKind as Kind } from '../../src/modules/wagering/domain/wager-transaction.types';
const probe = join(__dirname, '../helpers/process-probe-worker' + extname(__filename));
const command = { walletId: 'probe-only', kind: Kind.Loss, providerId: 'probe', playerId: 'probe', gameId: 'probe', roundId: 'probe',
  externalTransactionId: 'probe', idempotencyKey: 'probe', correlationId: 'probe', money: { amount: '0.00', currency: 'BRL' } } as const;

test('IPC harness starts 50 requests across three distinct Bun processes, without a database', async () => {
  const clients = [new BunProcessClient(probe), new BunProcessClient(probe), new BunProcessClient(probe)];
  try {
    const ready = await Promise.all(clients.map(client => client.ready));
    expect(new Set(ready.map(item => item.pid)).size).toBe(3); expect(ready.every(item => item.pid !== process.pid && item.backendPid === undefined)).toBe(true);
    console.log(JSON.stringify({ evidence: 'local-IPC-only-no-database', parentPid: process.pid, processes: ready.map(item => item.pid) }));
    const jobs = Array.from({ length: 50 }, (_, index) => clients[index % 3]!.prepare(command)); await Promise.all(jobs.map(job => job.armed));
    let completed = 0; for (const job of jobs) void job.result.then(() => { completed++; }).catch(() => {});
    expect(completed).toBe(0); for (const job of jobs) job.run();
    await Promise.all(jobs.map(job => job.started));
    const results = await Promise.all(jobs.map(job => job.result));
    expect(results).toHaveLength(50); expect(results.every(result => result.kind === 'probe')).toBe(true);
    expect(new Set(results.flatMap(result => result.kind === 'probe' ? [result.pid] : [])).size).toBe(3);
  } finally { await Promise.all(clients.map(client => client.close())); }
  expect(clients.every(client => client.child.exitCode !== null || client.child.signalCode !== null)).toBe(true);
});
test('checkpoint release is explicit rather than sleep-based', async () => {
  const client = new BunProcessClient(probe);
  try {
    await client.ready; const job = client.prepare(command, { pauseAt: 'before-commit' }); await job.armed; job.run();
    expect((await job.waitFor('before-commit')).pid).toBe(client.child.pid);
    let completed = false; void job.result.then(() => { completed = true; }).catch(() => {}); expect(completed).toBe(false);
    job.release(); expect((await job.result).kind).toBe('probe');
  } finally { await client.close(); }
});
test('premature child death rejects pending requests and closes the child', async () => {
  const client = new BunProcessClient(probe);
  try {
    await client.ready; const job = client.prepare(command, { pauseAt: 'before-commit' }); await job.armed; job.run(); await job.waitFor('before-commit');
    await client.kill(); await expect(job.result).rejects.toThrow('exited');
  } finally { await client.close(); }
  expect(client.child.exitCode !== null || client.child.signalCode !== null).toBe(true);
});
test('request timeout fails closed and teardown terminates a paused child', async () => {
  const client = new BunProcessClient(probe, process.env, 50);
  try {
    await client.ready; const job = client.prepare(command, { pauseAt: 'before-commit' }); await job.armed; job.run();
    await expect(job.result).rejects.toThrow('Timeout: worker request');
  } finally { await client.close(); }
  expect(client.child.exitCode !== null || client.child.signalCode !== null).toBe(true);
});
test('startup failure does not leave sibling children alive', async () => {
  const clients = [new BunProcessClient(probe), new BunProcessClient(join(__dirname, 'missing-worker.js')), new BunProcessClient(probe)];
  try { await expect(Promise.all(clients.map(client => client.ready))).rejects.toThrow('exited'); }
  finally { await Promise.all(clients.map(client => client.close())); }
  expect(clients.every(client => client.child.exitCode !== null || client.child.signalCode !== null)).toBe(true);
});
test('financial worker refuses to initialize outside the isolated Actions environment', async () => {
  const script = join(__dirname, '../helpers/wager-process-worker' + extname(__filename));
  const client = new BunProcessClient(script, { ...process.env, GITHUB_ACTIONS: 'false', PERSISTENCE_TEST_CONTAINER: '0' });
  try { await expect(client.ready).rejects.toThrow(); } finally { await client.close(); }
  expect(client.child.exitCode !== null || client.child.signalCode !== null).toBe(true);
});
