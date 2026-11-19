/** SIGTERM/SIGINT cover startup, draining and cleanup. Hard stop is process-local. */
export async function runWorkerProcess(work: (stop: AbortSignal) => Promise<void | 'stopped' | 'timed-out'>, shutdownGraceMs: number): Promise<void> {
  if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 1 || shutdownGraceMs > 120_000) throw new Error('Invalid shutdown limit');
  const stop = new AbortController(); let watchdog: ReturnType<typeof setTimeout> | undefined;
  const stopping = () => {
    if (stop.signal.aborted) return;
    stop.abort();
    watchdog = setTimeout(() => process.exit(1), shutdownGraceMs + 1000);
    watchdog.unref();
  };
  process.on('SIGTERM', stopping); process.on('SIGINT', stopping);
  try {
    // Cleanup belongs to work's finally. Do not leave abandoned I/O/timers alive after timeout.
    if (await work(stop.signal) === 'timed-out') process.exit(1);
  }
  finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    process.removeListener('SIGTERM', stopping); process.removeListener('SIGINT', stopping);
  }
}
