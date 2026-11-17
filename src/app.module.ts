import { Module } from '@nestjs/common';
import { WalletsModule } from './modules/wallets/wallets.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { OperationsModule } from './modules/operations/operations.module';

@Module({ imports: [WalletsModule, WageringModule, MessagingModule, OperationsModule] })
export class AppModule {}
