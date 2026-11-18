import { assertPersistenceTestEnvironment } from '../integration/environment';
export function assertSqsTestEnvironment(env: Record<string, string | undefined>): void {
  assertPersistenceTestEnvironment(env);
  if (env.SQS_ENDPOINT !== 'http://ministack:4566') throw new Error('SQS integration requires the isolated Actions MiniStack endpoint');
}
