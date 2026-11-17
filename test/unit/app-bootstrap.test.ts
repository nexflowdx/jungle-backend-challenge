import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { WalletsModule } from '../../src/modules/wallets/wallets.module';
import { WageringModule } from '../../src/modules/wagering/wagering.module';
import { MessagingModule } from '../../src/modules/messaging/messaging.module';
import { OperationsModule } from '../../src/modules/operations/operations.module';

@Injectable()
class Dependency {}

@Injectable()
class Consumer {
  constructor(readonly dependency: Dependency) {}
}

@Module({ imports: [AppModule], providers: [Dependency, Consumer] })
class BootstrapTestModule {}

test('bootstraps the modular application and resolves emitted constructor metadata', async () => {
  const application = await NestFactory.createApplicationContext(BootstrapTestModule, { logger: false, abortOnError: false });
  try {
    for (const module of [WalletsModule, WageringModule, MessagingModule, OperationsModule]) {
      expect(application.get(module)).toBeInstanceOf(module);
    }
    expect(Reflect.getMetadata('design:paramtypes', Consumer)).toEqual([Dependency]);
    expect(application.get(Consumer).dependency).toBe(application.get(Dependency));
  } finally {
    await application.close();
  }
});

test('initializes the HTTP adapter without opening a port', async () => {
  const application = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  try {
    await application.init();
    expect(application.getHttpServer().listening).toBe(false);
  } finally {
    await application.close();
  }
});
