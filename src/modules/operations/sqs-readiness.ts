import { ListQueuesCommand, SQSClient, type ListQueuesCommandOutput } from '@aws-sdk/client-sqs';
import type { ReadinessProbe } from './readiness';

export function sqsReadinessProbe(client: { send(command: ListQueuesCommand, options: { abortSignal: AbortSignal }): Promise<ListQueuesCommandOutput> }): ReadinessProbe {
  return async signal => {
    const response = await client.send(new ListQueuesCommand({ MaxResults: 1 }), { abortSignal: signal });
    if (response.$metadata.httpStatusCode !== 200) throw new Error('SQS readiness unconfirmed');
  };
}
/** No default AWS endpoint or credential-chain network access. */
export function createSqsReadiness(env: Record<string, string | undefined>) {
  let client: SQSClient | undefined;
  try {
    if (!env.SQS_ENDPOINT || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error();
    const url = new URL(env.SQS_ENDPOINT);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    client = new SQSClient({ endpoint: url.href, region: env.AWS_REGION || 'us-east-1', maxAttempts: 1,
      credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) },
      requestHandler: { connectionTimeout: 500, requestTimeout: 1000 } });
    return { probe: sqsReadinessProbe(client), close: () => client?.destroy() };
  } catch {
    client?.destroy();
    return { probe: async (_signal: AbortSignal) => { throw new Error('SQS readiness not configured'); }, close: () => {} };
  }
}
