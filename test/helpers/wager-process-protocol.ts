import type { SupportedWagerCommand, ProcessWagerTransactionResult } from '../../src/modules/wagering/application/process-wager-transaction';
export type FaultPoint = 'first-event' | 'before-commit';
export type PausePoint = 'locked' | 'before-commit' | 'after-commit';
export interface JobOptions { readonly pauseAt?: PausePoint; readonly failAt?: FaultPoint; }
export type ParentMessage =
  | { type: 'prepare'; id: string; command: SupportedWagerCommand; options: JobOptions }
  | { type: 'run' | 'release'; id: string }
  | { type: 'stop' };
export type Outcome =
  | { kind: 'result'; value: ProcessWagerTransactionResult }
  | { kind: 'error'; name: string; code?: string; reason?: string }
  | { kind: 'probe'; pid: number };
export interface Checkpoint { type: 'checkpoint'; id: string; phase: string; pid: number; backendPid?: number; transactionId?: string; }
export type WorkerMessage =
  | { type: 'ready'; pid: number; backendPid?: number }
  | { type: 'armed'; id: string }
  | { type: 'running'; id: string }
  | Checkpoint
  | { type: 'outcome'; id: string; outcome: Outcome }
  | { type: 'fatal' };
