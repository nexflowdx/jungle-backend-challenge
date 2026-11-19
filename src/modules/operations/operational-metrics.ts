import { randomUUID } from 'node:crypto';

const names = [
  'wager_replays', 'wager_responses_processed', 'wager_responses_rejected', 'wager_responses_pending_reference',
  'sqs_visibility_retries_confirmed', 'outbox_retries_scheduled', 'reference_retries_scheduled',
  'dlq_publications_confirmed', 'deadlocks_observed', 'serialization_failures_observed', 'lock_unavailable_observed',
  'reconciliation_consistent', 'reconciliation_divergent', 'reconciliation_inconclusive',
] as const;
export type OperationalCounter = typeof names[number];

/** Ephemeral observations for this process only; never financial source of truth. */
export class OperationalMetrics {
  private readonly counts = new Map<OperationalCounter, bigint>();
  private processingCount = 0n;
  private processingTotalMs = 0;
  private processingMaxMs = 0;
  readonly instanceId = randomUUID();
  readonly startedAt = new Date().toISOString();
  constructor(private readonly clock: () => number = () => performance.now()) {}
  async measureProcessing<T>(work: () => Promise<T>): Promise<T> {
    let started: number | undefined;
    try { started = this.clock(); } catch { /* Missing clock never prevents processing. */ }
    try { return await work(); }
    finally {
      try {
        if (started !== undefined) {
          const elapsed = this.clock() - started;
          // Numbers here are elapsed milliseconds, never monetary values.
          if (Number.isFinite(elapsed) && elapsed >= 0 && Number.isFinite(this.processingTotalMs + elapsed)) {
            this.processingCount++; this.processingTotalMs += elapsed;
            this.processingMaxMs = Math.max(this.processingMaxMs, elapsed);
          }
        }
      } catch { /* Observation failure cannot replace the original result/error. */ }
    }
  }
  increment(name: OperationalCounter): void {
    try { if (names.includes(name)) this.counts.set(name, (this.counts.get(name) ?? 0n) + 1n); }
    catch { /* Instrumentation never affects processing. */ }
  }
  observeWager(result: { readonly status: string; readonly idempotentReplay: boolean }): void {
    try {
      if (result.idempotentReplay) this.increment('wager_replays');
      if (result.status === 'PROCESSED') this.increment('wager_responses_processed');
      if (result.status === 'REJECTED') this.increment('wager_responses_rejected');
      if (result.status === 'PENDING_REFERENCE') this.increment('wager_responses_pending_reference');
    } catch { /* Responses include replays and are not unique transactions. */ }
  }
  observeSqlFailure(error: unknown): void {
    try {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === '40P01') this.increment('deadlocks_observed');
      if (code === '40001') this.increment('serialization_failures_observed');
      if (code === '55P03') this.increment('lock_unavailable_observed');
    } catch { /* No lock-conflict inference from arbitrary timeout messages. */ }
  }
  observeReconciliation(status: string): void {
    if (status === 'CONSISTENT') this.increment('reconciliation_consistent');
    if (status === 'DIVERGENT') this.increment('reconciliation_divergent');
    if (status === 'INCONCLUSIVE') this.increment('reconciliation_inconclusive');
  }
  snapshot() {
    return { scope: 'process-local' as const, ephemeral: true as const, instanceId: this.instanceId,
      processId: process.pid, startedAt: this.startedAt, collectedAt: new Date().toISOString(),
      counters: Object.fromEntries(names.map(name => [name, (this.counts.get(name) ?? 0n).toString()])),
      processingLatency: { unit: 'milliseconds' as const, observations: this.processingCount.toString(),
        total: this.processingTotalMs, maximum: this.processingMaxMs, includesFailuresAndReplays: true as const,
        includesLocksAndInternalRetries: true as const, includesTransportAck: false as const } };
  }
}
export const operationalMetrics = new OperationalMetrics();
