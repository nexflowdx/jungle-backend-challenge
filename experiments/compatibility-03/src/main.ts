import 'reflect-metadata';
import assert, { AssertionError } from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { BootstrapModule, BootstrapProbe, DatabaseProbe, DiagnosticModule, verifyOrmMetadata } from './diagnostic.module';
import { SqsProbe } from './sqs.probe';

async function main(): Promise<void> {
  assert.equal(process.versions['bun'], '1.4.4', 'The experiment must execute with Bun 1.4.4');
  const bootstrapOnly = process.argv.includes('--bootstrap-only');
  let application: INestApplicationContext | undefined;
  const deadline = setTimeout(() => {
    console.error(JSON.stringify({ check: 'diagnostic_deadline', status: 'failed' }));
    process.exit(1);
  }, 45_000);

  try {
    application = await NestFactory.createApplicationContext(
      bootstrapOnly ? BootstrapModule : DiagnosticModule,
      { logger: false, abortOnError: false },
    );
    application.get(BootstrapProbe).verify();
    console.log(JSON.stringify({ check: 'bun_nest_bootstrap_di_metadata', status: 'passed', bun: process.versions['bun'] }));
    if (bootstrapOnly) {
      await verifyOrmMetadata();
    } else {
      await application.get(DatabaseProbe).verify();
      await application.get(SqsProbe).verify();
    }
  } finally {
    try {
      await application?.close();
    } finally {
      clearTimeout(deadline);
    }
  }
}

main().catch((error: unknown) => {
  // Driver errors may include connection details. Do not dump them or credentials.
  console.error(JSON.stringify({
    check: 'compatibility_diagnostic',
    status: 'failed',
    errorType: error instanceof Error ? error.name : 'UnknownError',
    reason: error instanceof AssertionError ? error.message : 'See the last diagnostic phase; infrastructure details omitted',
  }));
  process.exitCode = 1;
});
