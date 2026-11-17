import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function main(): Promise<void> {
  if (process.argv.includes('--bootstrap-only')) {
    const application = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
    await application.close();
    console.log('NestJS bootstrap passed');
    return;
  }

  const application = await NestFactory.create(AppModule);
  application.enableShutdownHooks();
  // Only the explicit start/dev command opens a listener; bootstrap tests do not.
  await application.listen(3000, '127.0.0.1');
}

main().catch(() => {
  console.error('Application bootstrap failed');
  process.exitCode = 1;
});
