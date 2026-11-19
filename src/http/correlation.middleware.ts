import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonLogger } from '../modules/operations/json-logger';
import { currentLogContext, runWithLogContext } from '../modules/operations/log-context';

export function httpCorrelationId(): string { return currentLogContext().correlationId ?? randomUUID(); }

export function correlationMiddleware(logger: JsonLogger) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const header = request.headers['x-correlation-id'];
    const occurrences = request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'x-correlation-id').length;
    const correlationId = occurrences === 1 && typeof header === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(header) ? header : randomUUID();
    response.setHeader('X-Correlation-Id', correlationId);
    runWithLogContext({ correlationId }, () => {
      response.once('finish', () => runWithLogContext({ correlationId }, () => {
        logger.emit(response.statusCode >= 400 ? 'warn' : 'info', response.statusCode >= 400 ? 'http.failed' : 'http.completed');
      }));
      next();
    });
  };
}
