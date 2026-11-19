import { expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { ContinuousOutboxPublisher, outboxClientWithDeadline } from '../../src/modules/messaging/infrastructure/continuous-outbox-publisher';
import { OutboxPublicationCoordinator } from '../../src/modules/messaging/application/outbox-publication-coordinator';
import type { ReservedOutboxEvent } from '../../src/modules/messaging/application/outbox-reservation';
import { bounded } from '../helpers/bun-process-client';
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
test('publisher polls repeatedly and serially, continuing after an infrastructure failure', async () => {
  const stop = new AbortController(); let cycles = 0; let active = 0; let max = 0;
  const publisher = new ContinuousOutboxPublisher(async () => {
    max = Math.max(max, ++active); await Promise.resolve(); active--;
    if (++cycles === 1) throw new Error('database unavailable'); if (cycles === 3) stop.abort(); return { status: 'empty' };
  });
  expect(await publisher.run(stop.signal, { intervalMs: 10, shutdownGraceMs: 100 })).toBe('stopped');
  expect(cycles).toBe(3); expect(max).toBe(1);
});
test('uncertain publication schedules the original retry and never confirms the event', async () => {
  const stop = new AbortController(); let confirmations = 0; let retries = 0; let sends = 0;
  const event = { id: 'event', leaseToken: 'lease', attempts: 1 } as ReservedOutboxEvent;
  const coordinator = new OutboxPublicationCoordinator({ reserve: async () => [event] },
    { publish: async () => { sends++; throw new Error('response lost'); } },
    { confirm: async () => { confirmations++; return true; } },
    { schedule: async () => { retries++; stop.abort(); return true; } }, () => 0.5);
  expect(await new ContinuousOutboxPublisher(() => coordinator.processOnce()).run(stop.signal, { intervalMs: 10, shutdownGraceMs: 100 })).toBe('stopped');
  expect(sends).toBe(1); expect(retries).toBe(1); expect(confirmations).toBe(0);
});
test('shutdown drains a confirmed publication and does not reserve another event', async () => {
  const stop = new AbortController(); const entered = barrier(); const sending = barrier(); let reserved = 0; let confirmed = 0;
  const coordinator = new OutboxPublicationCoordinator({ reserve: async () => { reserved++; return [{ id: 'event', leaseToken: 'lease', attempts: 1 } as ReservedOutboxEvent]; } },
    { publish: async () => { entered.release(); await sending.promise; } }, { confirm: async () => { confirmed++; return true; } }, { schedule: async () => true });
  const running = new ContinuousOutboxPublisher(() => coordinator.processOnce()).run(stop.signal, { intervalMs: 10, shutdownGraceMs: 1000 });
  await entered.promise; stop.abort(); expect(confirmed).toBe(0); sending.release();
  expect(await running).toBe('stopped'); expect(confirmed).toBe(1); expect(reserved).toBe(1);
});
test('shutdown deadline is bounded and late completion never starts a second iteration', async () => {
  const stop = new AbortController(); const entered = barrier(); const pending = barrier(); let iterations = 0; let aborted: boolean | undefined;
  const running = new ContinuousOutboxPublisher(async deadline => { iterations++; entered.release(); await pending.promise; aborted = deadline.aborted; return { status: 'empty' }; })
    .run(stop.signal, { intervalMs: 10, shutdownGraceMs: 5 });
  await entered.promise; stop.abort(); expect(await bounded(running, 1000, 'publisher shutdown')).toBe('timed-out');
  pending.release(); await new Promise<void>(resolve => setImmediate(resolve)); expect(aborted).toBe(true); expect(iterations).toBe(1);
});
test('deadline gate combines coordinator cancellation and refuses late SDK sends', async () => {
  const deadline = new AbortController(); const publication = new AbortController(); let calls = 0; let observed: AbortSignal | undefined;
  const client = outboxClientWithDeadline({ send: async (_, options) => { calls++; observed = options?.abortSignal; return { $metadata: {} }; } }, deadline.signal);
  await client.send(new SendMessageCommand({ QueueUrl: 'queue', MessageBody: 'event' }), { abortSignal: publication.signal });
  publication.abort(); expect(observed?.aborted).toBe(true); deadline.abort();
  await expect(client.send(new SendMessageCommand({ QueueUrl: 'queue', MessageBody: 'event' }))).rejects.toThrow('deadline'); expect(calls).toBe(1);
});
test.each([{ intervalMs: 0, shutdownGraceMs: 1000 }, { intervalMs: 60001, shutdownGraceMs: 1000 }, { intervalMs: 10, shutdownGraceMs: 0 }])('invalid polling limits %# cannot start work', async options => {
  let called = false; const publisher = new ContinuousOutboxPublisher(async () => { called = true; return { status: 'empty' }; });
  await expect(publisher.run(new AbortController().signal, options)).rejects.toThrow('limits'); expect(called).toBe(false);
});
