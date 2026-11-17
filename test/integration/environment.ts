export function assertPersistenceTestEnvironment(env: Record<string, string | undefined>): void {
  if (env.GITHUB_ACTIONS !== 'true' || env.PERSISTENCE_TEST_CONTAINER !== '1' ||
    env.PGHOST !== 'postgres' || env.PGDATABASE !== 'jungle_persistence_test' ||
    env.PGUSER !== 'diagnostic' || !env.PGPASSWORD) {
    throw new Error('Persistence integration requires the isolated Actions Compose database; no external database is accepted');
  }
}
