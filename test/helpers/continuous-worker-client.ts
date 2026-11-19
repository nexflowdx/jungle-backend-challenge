import { join, extname } from 'node:path';
import { bounded } from './bun-process-client';

/** CI-only process fixture; stdout may contain sanitized application JSON logs. */
export class ContinuousWorkerClient {
  readonly child: Bun.Subprocess<'pipe', 'pipe', 'ignore'>;
  private readonly records: { type: string }[] = [];
  private readonly waiters: { type: string; count: number; resolve: () => void; reject: (error: Error) => void }[] = [];
  constructor(script: string, env: Record<string, string | undefined>) {
    this.child = Bun.spawn([process.execPath, join(__dirname, script + extname(__filename))], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
    void this.read().catch(() => { this.rejectWaiters(); });
  }
  private rejectWaiters() { for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('Continuous worker exited before checkpoint')); }
  private async read() {
    const reader = this.child.stdout.getReader(); const decoder = new TextDecoder(); let buffer = '';
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
          let value: unknown; try { value = JSON.parse(line); } catch { continue; }
          if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') continue;
          this.records.push({ type: value.type });
          for (let i = this.waiters.length - 1; i >= 0; i--) {
            const waiter = this.waiters[i]!;
            if (this.records.filter(record => record.type === waiter.type).length >= waiter.count) { this.waiters.splice(i, 1); waiter.resolve(); }
          }
        }
      }
    } finally { reader.releaseLock(); this.rejectWaiters(); }
  }
  waitFor(type: string, count = 1): Promise<void> {
    if (this.records.filter(record => record.type === type).length >= count) return Promise.resolve();
    return bounded(new Promise<void>((resolve, reject) => { this.waiters.push({ type, count, resolve, reject }); }), 8000, `worker checkpoint ${type}`);
  }
  release() { this.child.stdin.write('release\n'); void Promise.resolve(this.child.stdin.flush()).catch(() => {}); }
  stop(signal: 'SIGTERM' | 'SIGINT' = 'SIGTERM') { this.child.kill(signal); }
  async exited() { return bounded(this.child.exited, 5000, 'worker exit'); }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.stop();
    try { await this.exited(); } catch { this.child.kill('SIGKILL'); await bounded(this.child.exited, 3000, 'worker cleanup'); }
  }
}
