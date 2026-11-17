import { assertPersistenceTestEnvironment } from '../test/integration/environment';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPostgresReport } from './integration-report';

async function main(): Promise<void> {
  assertPersistenceTestEnvironment(process.env);
  const directory = await mkdtemp(join(tmpdir(), 'jungle-postgres-report-'));
  try {
    const report = join(directory, 'results.xml');
    const child = Bun.spawn([process.execPath, 'test', './.test-dist/test/integration/postgres.test.js',
      './.test-dist/test/integration/wallet-opening.test.js',
      './.test-dist/test/integration/wager-processing.test.js',
      './.test-dist/test/integration/wager-identity.test.js',
      './.test-dist/test/integration/bet-processing.test.js',
      '--timeout=10000', '--reporter=junit', `--reporter-outfile=${report}`], {
      env: { ...process.env, PERSISTENCE_INTEGRATION: '1' }, stdout: 'inherit', stderr: 'inherit',
    });
    const code = await child.exited;
    if (code !== 0) throw new Error(`PostgreSQL integration failed with exit code ${code}`);
    assertPostgresReport(await readFile(report, 'utf8'));
    console.log('PostgreSQL integration verified: all required tests ran, zero skips.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
