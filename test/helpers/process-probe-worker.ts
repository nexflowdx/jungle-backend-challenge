import { createInterface } from 'node:readline';
import type { ParentMessage, WorkerMessage } from './wager-process-protocol';
// IPC-only unit fixture. Imports no database, financial domain or use case at runtime.
const send = (message: WorkerMessage) => process.stdout.write(JSON.stringify(message) + '\n');
const jobs = new Map<string, ParentMessage & { type: 'prepare' }>();
const releases = new Map<string, () => void>();
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line) as ParentMessage;
  if (message.type === 'prepare') { jobs.set(message.id, message); send({ type: 'armed', id: message.id }); }
  if (message.type === 'release') releases.get(message.id)?.();
  if (message.type === 'run') {
    send({ type: 'running', id: message.id });
    const job = jobs.get(message.id)!;
    if (job.options.pauseAt) {
      releases.set(message.id, () => send({ type: 'outcome', id: message.id, outcome: { kind: 'probe', pid: process.pid } }));
      send({ type: 'checkpoint', id: message.id, pid: process.pid, phase: job.options.pauseAt });
    } else send({ type: 'outcome', id: message.id, outcome: { kind: 'probe', pid: process.pid } });
  }
  if (message.type === 'stop') { input.close(); process.stdin.destroy(); }
});
input.on('close', () => { process.exitCode = 0; });
send({ type: 'ready', pid: process.pid });
