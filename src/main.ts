import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createHttpApplication } from './http/http-api.module';
import { createHttpPersistence, httpDatabaseConnection } from './http/runtime-persistence';

async function main(): Promise<void> {
  if (process.argv.includes('--bootstrap-only')) {
    const application = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
    await application.close();
    console.log('NestJS bootstrap passed');
    return;
  }

  const persistence = await createHttpPersistence(httpDatabaseConnection(process.env));
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;
  try {
    application = await createHttpApplication(persistence);
    application.enableShutdownHooks();
    // Only explicit start/dev opens a listener. Migrations remain a separate operation.
    await application.listen(3000, '127.0.0.1');
  } catch (error) {
    if (application) await application.close(); else await persistence.close?.();
    throw error;
  }
}

main().catch(() => {
  console.error('Application bootstrap failed');
  process.exitCode = 1;
});
