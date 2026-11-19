export interface SerialWorkerOptions { readonly intervalMs: number; readonly shutdownGraceMs: number }
export type WorkerExit = 'stopped' | 'timed-out';
export function assertWorkerOptions(options: SerialWorkerOptions): void {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 10 || options.intervalMs > 60_000
    || !Number.isSafeInteger(options.shutdownGraceMs) || options.shutdownGraceMs < 1 || options.shutdownGraceMs > 120_000) {
    throw new Error('Invalid worker limits');
  }
}
function pause(ms: number, stop: AbortSignal): Promise<void> {
  if (stop.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); stop.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); stop.addEventListener('abort', done, { once: true });
  });
}
/** One step at a time; stopping never starts another step or cancels a financial commit. */
export async function runSerialWorker(step: (deadline: AbortSignal) => Promise<void>, stop: AbortSignal,
  options: SerialWorkerOptions, onError: () => void): Promise<WorkerExit> {
  assertWorkerOptions(options);
  if (stop.aborted) return 'stopped';
  const deadline = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  let expired!: (value: WorkerExit) => void;
  const timeout = new Promise<WorkerExit>(resolve => { expired = resolve; });
  const stopping = () => {
    timer = setTimeout(() => { deadline.abort(); expired('timed-out'); }, options.shutdownGraceMs);
  };
  stop.addEventListener('abort', stopping, { once: true });
  const loop = (async (): Promise<WorkerExit> => {
    while (!stop.aborted) {
      try { await step(deadline.signal); } catch { onError(); }
      await pause(options.intervalMs, stop);
    }
    return 'stopped';
  })();
  // Always observe late work rejection, including after the shutdown deadline.
  void loop.catch(() => {});
  try { return await Promise.race([loop, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); stop.removeEventListener('abort', stopping); }
}
