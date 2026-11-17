import type { SupportedWagerCommand } from '../../src/modules/wagering/application/process-wager-transaction';
import type { Checkpoint, JobOptions, Outcome, ParentMessage, WorkerMessage } from './wager-process-protocol';

type Ready = Extract<WorkerMessage, { type: 'ready' }>;
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Teardown/early exit may precede the caller's await; do not hide the original rejection.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
export function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  const result = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), milliseconds);
    void promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  void result.catch(() => {});
  return result;
}
interface Job {
  armed: ReturnType<typeof deferred<void>>;
  started: ReturnType<typeof deferred<void>>;
  result: ReturnType<typeof deferred<Outcome>>;
  checkpoints: Map<string, Checkpoint>;
  waiters: Map<string, ReturnType<typeof deferred<Checkpoint>>>;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
}
export class BunProcessClient {
  readonly child: Bun.Subprocess<'pipe', 'pipe', 'ignore'>;
  readonly ready: Promise<Ready>;
  private readonly started = deferred<Ready>();
  private readonly jobs = new Map<string, Job>();
  private stopping: Promise<void> | undefined;
  private exited = false;
  private sequence = 0;
  constructor(script: string, env: Record<string, string | undefined> = process.env, private readonly jobTimeout = 12000) {
    this.child = Bun.spawn([process.execPath, script], {
      env, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
    });
    void this.readMessages();
    this.ready = bounded(this.started.promise, 10000, 'worker readiness');
    void this.ready.catch(() => {});
    void this.child.exited.then(() => {
      this.exited = true;
      this.fail(new Error(`Worker ${this.child.pid} exited`));
    });
  }
  private async readMessages() {
    const reader = this.child.stdout.getReader(); const decoder = new TextDecoder(); let buffer = '';
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
          if (line) this.receive(JSON.parse(line) as WorkerMessage);
        }
        if (buffer.length > 65536) throw new Error('Invalid worker protocol');
      }
    } catch { this.fail(new Error('Worker protocol failed')); }
    finally { reader.releaseLock(); }
  }
  private send(message: ParentMessage) {
    if (this.exited || this.stopping && message.type !== 'stop') throw new Error('Worker is closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
    void Promise.resolve(this.child.stdin.flush()).catch(() => this.fail(new Error('Worker input closed')));
  }
  private fail(error: Error) {
    this.started.reject(error);
    for (const job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      job.armed.reject(error); job.started.reject(error); job.result.reject(error);
      for (const waiter of job.waiters.values()) waiter.reject(error);
    }
  }
  private receive(message: WorkerMessage) {
    if (message.type === 'ready') {
      if (message.pid !== this.child.pid) { this.fail(new Error('Worker PID mismatch')); return; }
      this.started.resolve(message); return;
    }
    if (message.type === 'fatal') { this.fail(new Error('Worker initialization failed')); return; }
    const job = this.jobs.get(message.id);
    if (!job) { this.fail(new Error('Unknown worker job')); return; }
    if (message.type === 'armed') job.armed.resolve();
    else if (message.type === 'running') job.started.resolve();
    else if (message.type === 'checkpoint') {
      job.checkpoints.set(message.phase, message); job.waiters.get(message.phase)?.resolve(message);
    } else {
      if (job.timer) clearTimeout(job.timer);
      job.result.resolve(message.outcome);
    }
  }
  prepare(command: SupportedWagerCommand, options: JobOptions = {}) {
    const id = `${this.child.pid}-${++this.sequence}`;
    const job: Job = { armed: deferred<void>(), started: deferred<void>(), result: deferred<Outcome>(), checkpoints: new Map(), waiters: new Map(), running: false };
    this.jobs.set(id, job);
    this.send({ type: 'prepare', id, command, options });
    return {
      id, pid: this.child.pid,
      armed: bounded(job.armed.promise, 5000, 'arming request'), started: bounded(job.started.promise, 10000, 'request start'), result: job.result.promise,
      run: () => {
        if (job.running) throw new Error('Job already running'); job.running = true;
        job.timer = setTimeout(() => job.result.reject(new Error('Timeout: worker request')), this.jobTimeout);
        this.send({ type: 'run', id });
      },
      waitFor: (phase: string) => {
        const existing = job.checkpoints.get(phase); if (existing) return Promise.resolve(existing);
        let waiter = job.waiters.get(phase); if (!waiter) { waiter = deferred<Checkpoint>(); job.waiters.set(phase, waiter); }
        return bounded(waiter.promise, 5000, `worker checkpoint ${phase}`);
      },
      release: () => this.send({ type: 'release', id }),
    };
  }
  async kill(): Promise<void> { if (!this.exited) this.child.kill('SIGKILL'); await bounded(this.child.exited, 3000, 'worker kill'); }
  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      try {
        if (!this.exited) { this.child.stdin.write(JSON.stringify({ type: 'stop' }) + '\n'); await this.child.stdin.flush(); }
        await bounded(this.child.exited, 3000, 'worker shutdown');
      } catch { await this.kill(); }
      finally { this.fail(new Error('Worker closed')); }
    })();
    return this.stopping;
  }
}
