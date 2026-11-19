import { SQSClient } from '@aws-sdk/client-sqs';
import { httpDatabaseConnection } from '../../http/runtime-persistence';
import { configuration } from '../messaging/infrastructure/sqs-wager-receiver';

export function workerConfiguration(env: Record<string, string | undefined>) {
  const required = (name: string) => { const value = env[name]; if (!value?.trim()) throw new Error('Missing worker configuration'); return value; };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = env[name]; if (value === undefined) return fallback;
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error('Invalid worker limit');
    return Number(value);
  };
  const endpoint = required('SQS_ENDPOINT'); const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid SQS endpoint');
  if (env.AWS_REGION && !/^[a-z0-9-]+$/.test(env.AWS_REGION)) throw new Error('Invalid AWS region');
  return { database: httpDatabaseConnection(env), endpoint,
    region: env.AWS_REGION || 'us-east-1',
    credentials: { accessKeyId: required('AWS_ACCESS_KEY_ID'), secretAccessKey: required('AWS_SECRET_ACCESS_KEY'),
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) },
    shutdownGraceMs: integer('WORKER_SHUTDOWN_GRACE_MS', 30_000, 1000, 120_000),
    intervalMs: integer('WORKER_POLL_INTERVAL_MS', 250, 10, 60_000),
    waitTimeSeconds: integer('SQS_WAIT_TIME_SECONDS', 10, 1, 20),
    visibilityTimeout: integer('SQS_VISIBILITY_TIMEOUT_SECONDS', 120, 30, 600),
  };
}
export function workerSqsClient(settings: ReturnType<typeof workerConfiguration>): SQSClient {
  return new SQSClient({ endpoint: settings.endpoint, region: settings.region, credentials: settings.credentials,
    maxAttempts: 1, useQueueUrlAsEndpoint: false,
    requestHandler: { connectionTimeout: 2000, requestTimeout: (settings.waitTimeSeconds + 5) * 1000 } });
}
export function consumerConfiguration(env: Record<string, string | undefined>, settings: ReturnType<typeof workerConfiguration>) {
  if (!env.SQS_QUEUE_URL || !env.SQS_DLQ_URL) throw new Error('Missing consumer queue URLs');
  return { configuration: configuration({ endpoint: settings.endpoint, region: settings.region,
    queueUrl: env.SQS_QUEUE_URL, visibilityTimeout: settings.visibilityTimeout, waitTimeSeconds: settings.waitTimeSeconds }), dlqUrl: env.SQS_DLQ_URL };
}
