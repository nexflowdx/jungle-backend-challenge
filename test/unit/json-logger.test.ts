import { expect, test } from 'bun:test';
import { JsonLogger, NestJsonLogger } from '../../src/modules/operations/json-logger';
import { currentLogContext, runWithLogContext, type LogIdentifiers } from '../../src/modules/operations/log-context';

const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
test('every line is JSON with only explicit allowed fields and immutable context captured at emission', async () => {
  const lines: string[] = []; const logger = new JsonLogger(line => lines.push(line), () => new Date('2026-11-19T12:00:00Z'));
  runWithLogContext({ correlationId: 'correlation', messageId: 'envelope' }, () => logger.emit('info', 'sqs.command_committed', {
    transactionId: 'transaction', walletId: 'wallet', providerId: 'provider',
    token: 'TOKEN_SECRET', password: 'PASSWORD_SECRET', receiptHandle: 'RECEIPT_SECRET',
    payload: { money: 'FINANCIAL_SECRET' }, playerId: 'PLAYER_SECRET', error: new Error('DRIVER_SECRET'),
  } as LogIdentifiers));
  expect(lines).toHaveLength(0); await flush();
  expect(lines).toHaveLength(1); expect(lines[0]!.endsWith('\n')).toBe(true);
  expect(JSON.parse(lines[0]!)).toEqual({ timestamp: '2026-11-19T12:00:00.000Z', level: 'info', event: 'sqs.command_committed',
    correlationId: 'correlation', messageId: 'envelope', transactionId: 'transaction', walletId: 'wallet', providerId: 'provider' });
  expect(lines.join('')).not.toContain('SECRET'); expect(currentLogContext()).toEqual({});
});
test('unknown or unsafe identifiers and arbitrary framework messages are omitted', async () => {
  const lines: string[] = []; const logger = new JsonLogger(line => lines.push(line));
  logger.emit('warn', 'http.failed', { correlationId: 'with\nnewline', walletId: 'x'.repeat(257) });
  new NestJsonLogger(logger).error('password=SECRET', 'Bearer TOKEN');
  await flush();
  expect(lines.map(line => Object.keys(JSON.parse(line)).sort())).toEqual([
    ['event', 'level', 'timestamp'], ['event', 'level', 'timestamp'],
  ]); expect(lines.join('')).not.toContain('SECRET'); expect(lines.join('')).not.toContain('TOKEN');
});
test('sync sink errors, async rejection and invalid clock never escape or create unhandled rejections', async () => {
  new JsonLogger(() => { throw new Error('secret'); }).emit('error', 'http.failed');
  new JsonLogger(() => Promise.reject(new Error('secret'))).emit('error', 'http.failed');
  new JsonLogger(() => { throw new Error(); }, () => { throw new Error(); }).emit('error', 'http.failed');
  await flush(); expect(currentLogContext()).toEqual({});
});
test('an unresolved sink is never awaited by business code', async () => {
  let writes = 0; const logger = new JsonLogger(() => { writes++; return new Promise(() => {}); });
  logger.emit('info', 'wallet.opened'); const result = await Promise.resolve('committed');
  expect(result).toBe('committed'); expect(writes).toBe(1);
});
test('context preserves original non-HTTP identifiers even when the output policy omits them', () => {
  runWithLogContext({ correlationId: 'mensagem original é válida', messageId: 'mensagem original é válida' }, () => {
    expect(currentLogContext()).toEqual({ correlationId: 'mensagem original é válida', messageId: 'mensagem original é válida' });
  });
  expect(currentLogContext()).toEqual({});
});
test('concurrent contexts remain isolated across awaits and nested context restores its parent', async () => {
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const results = ['a', 'b'].map(correlationId => runWithLogContext({ correlationId }, async () => {
    expect(Object.isFrozen(currentLogContext())).toBe(true); await barrier;
    expect(currentLogContext()).toEqual({ correlationId });
    runWithLogContext({ correlationId: 'nested' }, () => expect(currentLogContext().correlationId).toBe('nested'));
    return currentLogContext().correlationId;
  }));
  release(); expect(await Promise.all(results)).toEqual(['a', 'b']); expect(currentLogContext()).toEqual({});
});
