import 'reflect-metadata';
import { afterEach, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { ListQueuesCommand } from '@aws-sdk/client-sqs';
import { ReadinessService } from '../../src/modules/operations/readiness';
import { createSqsReadiness, sqsReadinessProbe } from '../../src/modules/operations/sqs-readiness';
import { createHttpApplication } from '../../src/http/http-api.module';
import { JsonLogger } from '../../src/modules/operations/json-logger';
import { HttpMemoryPersistence } from '../helpers/http-memory-persistence';
import { httpRequest } from '../helpers/http-request';

let application: INestApplication | undefined;
afterEach(async () => { await application?.close(); application = undefined; });
async function start(readiness?: ReadinessService) {
  const persistence = new HttpMemoryPersistence();
  application = await createHttpApplication({ ...persistence, ...(readiness ? { readiness } : {}) }, { logger: false }, undefined, new JsonLogger(() => {}));
  await application.init(); return persistence;
}
const get = (path: string) => httpRequest(application!, path, undefined, [], undefined, 'GET');
test('public liveness requires no credentials and performs no dependency or financial work', async () => {
  let probes = 0;
  const persistence = await start(new ReadinessService({ postgres: async () => { probes++; }, sqs: async () => { probes++; } }));
  expect(await get('/health/live')).toEqual({ status: 200, body: { status: 'alive' } });
  expect(probes).toBe(0); expect(persistence.calls).toBe(0);
});
test('public readiness returns 200 only when both actual probes succeed', async () => {
  const calls: string[] = [];
  const persistence = await start(new ReadinessService({ postgres: async () => { calls.push('pg'); }, sqs: async () => { calls.push('sqs'); } }));
  expect(await get('/health/ready')).toEqual({ status: 200, body: { status: 'ready', checks: { postgres: 'up', sqs: 'up' } } });
  expect(calls.sort()).toEqual(['pg', 'sqs']); expect(persistence.calls).toBe(0);
});
test.each(['postgres', 'sqs'])('unavailable %s returns sanitized 503 while liveness remains 200', async name => {
  const failure = async () => { throw new Error('SECRET password=credential token=TOKEN'); };
  await start(new ReadinessService({ postgres: name === 'postgres' ? failure : async () => {}, sqs: name === 'sqs' ? failure : async () => {} }));
  const result = await get('/health/ready'); expect(result.status).toBe(503); expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(await get('/health/live')).toEqual({ status: 200, body: { status: 'alive' } });
});
test('missing readiness configuration fails closed rather than reporting fake readiness', async () => {
  await start(); expect((await get('/health/ready')).status).toBe(503);
});
test('hung probes time out, are aborted and never accumulate new in-flight work', async () => {
  let calls = 0; let signal: AbortSignal | undefined;
  const readiness = new ReadinessService({ postgres: async value => { calls++; signal = value; await new Promise(() => {}); }, sqs: async () => {} }, 5);
  await start(readiness);
  expect((await get('/health/ready')).status).toBe(503); expect(signal?.aborted).toBe(true);
  expect((await get('/health/ready')).status).toBe(503); expect(calls).toBe(1);
});
test('a dependency can recover after a failed probe', async () => {
  let healthy = false;
  const readiness = new ReadinessService({ postgres: async () => { if (!healthy) throw new Error(); }, sqs: async () => {} });
  expect((await readiness.check()).status).toBe('not_ready'); healthy = true;
  expect((await readiness.check()).status).toBe('ready');
});
test('SQS probe uses only ListQueues with abort signal and requires explicit 200 confirmation', async () => {
  const controller = new AbortController(); let calls = 0;
  await sqsReadinessProbe({ send: async (command, options) => {
    calls++; expect(command).toBeInstanceOf(ListQueuesCommand); expect(command.input).toEqual({ MaxResults: 1 });
    expect(options.abortSignal).toBe(controller.signal); return { $metadata: { httpStatusCode: 200 } };
  } })(controller.signal);
  expect(calls).toBe(1);
  await expect(sqsReadinessProbe({ send: async () => ({ $metadata: {} }) })(controller.signal)).rejects.toThrow('unconfirmed');
});
test('missing/unsafe SQS config never falls back to AWS credential metadata or an implicit endpoint', async () => {
  for (const env of [{}, { SQS_ENDPOINT: 'file:///etc/passwd', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' }]) {
    const sqs = createSqsReadiness(env);
    await expect(sqs.probe(new AbortController().signal)).rejects.toThrow('not configured'); sqs.close();
  }
});
test.each([0, -1, 5001, NaN])('invalid readiness timeout %s is rejected', timeout => {
  expect(() => new ReadinessService({ postgres: async () => {}, sqs: async () => {} }, timeout)).toThrow();
});
