export type ReadinessProbe = (signal: AbortSignal) => Promise<void>;

/** One actual I/O per dependency at a time, including operations outliving timeout. */
class BoundedProbe {
  private running: { promise: Promise<boolean>; controller: AbortController } | undefined;
  constructor(private readonly probe: ReadinessProbe, private readonly timeoutMs: number) {}
  check(): Promise<boolean> {
    if (!this.running) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => this.probe(controller.signal)).then(() => true, () => false);
      const entry = { promise, controller };
      this.running = entry;
      void promise.then(() => { if (this.running === entry) this.running = undefined; });
    }
    const entry = this.running;
    return new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => {
        try { entry.controller.abort(); } catch { /* Sanitize cancellation failures. */ }
        resolve(false);
      }, this.timeoutMs);
      void entry.promise.then(result => { clearTimeout(timeout); resolve(result); });
    });
  }
}
export class ReadinessService {
  private readonly postgres: BoundedProbe;
  private readonly sqs: BoundedProbe;
  constructor(probes: { postgres: ReadinessProbe; sqs: ReadinessProbe }, timeoutMs = 1500) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('Invalid readiness timeout');
    this.postgres = new BoundedProbe(probes.postgres, timeoutMs);
    this.sqs = new BoundedProbe(probes.sqs, timeoutMs);
  }
  async check() {
    const [postgres, sqs] = await Promise.all([this.postgres.check(), this.sqs.check()]);
    return { status: postgres && sqs ? 'ready' as const : 'not_ready' as const,
      checks: { postgres: postgres ? 'up' as const : 'down' as const, sqs: sqs ? 'up' as const : 'down' as const } };
  }
}
export function unavailableReadiness(): ReadinessService {
  const unavailable = async () => { throw new Error('Readiness dependency not configured'); };
  return new ReadinessService({ postgres: unavailable, sqs: unavailable });
}
