import { write } from 'node:fs';
import type { LoggerService } from '@nestjs/common';
import { currentLogContext, logIdentifiers, type LogIdentifiers } from './log-context';

const events = [
  'http.completed', 'http.failed', 'wallet.opened', 'wager.completed',
  'sqs.command_committed', 'sqs.command_failed', 'outbox.publication_confirmed', 'outbox.publication_failed',
  'pending_reference.completed', 'pending_reference.failed', 'pending_reference.batch_completed', 'pending_reference.worker_failed',
  'application.bootstrap_passed', 'application.bootstrap_failed',
  'metrics.query_failed',
  'reconciliation.divergent', 'reconciliation.inconclusive',
  'framework.log', 'framework.warn', 'framework.error', 'framework.debug', 'framework.verbose', 'framework.fatal',
] as const;
export type LogEvent = typeof events[number];
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogSink = (line: string) => unknown;

/** Best effort only: no await, no retry, no rejection escapes to business code. */
export class JsonLogger {
  constructor(private readonly sink: LogSink = line => { write(1, line, () => {}); }, private readonly now: () => Date = () => new Date()) {}

  emit(level: LogLevel, event: LogEvent, identifiers: LogIdentifiers = {}): void {
    try {
      if (!events.includes(event) || !['info', 'warn', 'error', 'debug'].includes(level)) return;
      const line = JSON.stringify({ timestamp: this.now().toISOString(), level, event,
        ...logIdentifiers({ ...currentLogContext(), ...logIdentifiers(identifiers) }) }) + '\n';
      queueMicrotask(() => {
        try { void Promise.resolve(this.sink(line)).catch(() => {}); } catch { /* Losing a log must never change a financial outcome. */ }
      });
    } catch { /* Invalid observability metadata is discarded. */ }
  }
}
export const jsonLogger = new JsonLogger();

/** Nest diagnostics share the JSON format, without forwarding arbitrary messages. */
export class NestJsonLogger implements LoggerService {
  constructor(private readonly logger: JsonLogger) {}
  log(_message: unknown, ..._optional: unknown[]) { this.logger.emit('info', 'framework.log'); }
  warn(_message: unknown, ..._optional: unknown[]) { this.logger.emit('warn', 'framework.warn'); }
  error(_message: unknown, ..._optional: unknown[]) { this.logger.emit('error', 'framework.error'); }
  debug(_message: unknown, ..._optional: unknown[]) { this.logger.emit('debug', 'framework.debug'); }
  verbose(_message: unknown, ..._optional: unknown[]) { this.logger.emit('debug', 'framework.verbose'); }
  fatal(_message: unknown, ..._optional: unknown[]) { this.logger.emit('error', 'framework.fatal'); }
}
