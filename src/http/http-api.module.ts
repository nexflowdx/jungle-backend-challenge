import { Module, type DynamicModule, type NestApplicationOptions } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { WalletsModule } from '../modules/wallets/wallets.module';
import { WalletOpeningUnitOfWork } from '../modules/wallets/application/wallet-opening-unit-of-work';
import { WageringModule } from '../modules/wagering/wagering.module';
import { WagerProcessingUnitOfWork } from '../modules/wagering/application/wager-processing-unit-of-work';
import { WalletsController } from './wallets.controller';
import { WageringTransactionsController } from './wagering-transactions.controller';
import { WalletRequestPipe, WagerRequestPipe } from './request-validation';
import { HttpErrorFilter } from './http-error.filter';
import { ProviderAuthenticationGuard } from './provider-authentication.guard';

export interface HttpPersistence {
  readonly walletOpening: WalletOpeningUnitOfWork;
  readonly wagerProcessing: WagerProcessingUnitOfWork;
  readonly close?: () => Promise<void>;
}
@Module({})
export class HttpApiModule {
  static register(persistence: HttpPersistence): DynamicModule {
    return { module: HttpApiModule,
      imports: [WalletsModule.register(persistence.walletOpening), WageringModule.register(persistence.wagerProcessing)],
      controllers: [WalletsController, WageringTransactionsController],
      providers: [WalletRequestPipe, WagerRequestPipe, ProviderAuthenticationGuard, { provide: APP_FILTER, useClass: HttpErrorFilter },
        { provide: 'HTTP_PERSISTENCE_LIFECYCLE', useValue: { onApplicationShutdown: async () => { await persistence.close?.(); } } }],
    };
  }
}
export function createHttpApplication(persistence: HttpPersistence, options: NestApplicationOptions = {}) {
  return NestFactory.create(HttpApiModule.register(persistence), { abortOnError: false, ...options });
}
