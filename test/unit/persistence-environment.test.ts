import { expect, test } from 'bun:test';
import { assertPersistenceTestEnvironment } from '../integration/environment';

const isolated = {
  GITHUB_ACTIONS: 'true', PERSISTENCE_TEST_CONTAINER: '1', PGHOST: 'postgres',
  PGDATABASE: 'jungle_persistence_test', PGUSER: 'diagnostic', PGPASSWORD: 'temporary-test-only',
};
test('integration harness accepts the isolated container contract', () => {
  expect(() => assertPersistenceTestEnvironment(isolated)).not.toThrow();
});
test.each(Object.keys(isolated))('integration harness rejects missing %s', key => {
  expect(() => assertPersistenceTestEnvironment({ ...isolated, [key]: undefined })).toThrow();
});
test.each([
  { PGHOST: 'production.example' }, { PGDATABASE: 'production' }, { PGUSER: 'postgres' },
  { GITHUB_ACTIONS: 'false' }, { PERSISTENCE_TEST_CONTAINER: '0' },
])('integration harness rejects external or unapproved environments %j', override => {
  expect(() => assertPersistenceTestEnvironment({ ...isolated, ...override })).toThrow();
});
