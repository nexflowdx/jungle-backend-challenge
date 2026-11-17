import { Module, type DynamicModule } from '@nestjs/common';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import { WagerProcessingUnitOfWork } from './application/wager-processing-unit-of-work';
import { WagerTransactionIdentity } from './application/wager-transaction-identity';

@Module({})
export class WageringModule {
  static register(unitOfWork: WagerProcessingUnitOfWork): DynamicModule {
    return {
      module: WageringModule,
      providers: [
        { provide: WagerTransactionIdentity, useFactory: () => new WagerTransactionIdentity() },
        { provide: WagerProcessingUnitOfWork, useValue: unitOfWork },
        { provide: ProcessWagerTransaction, useFactory: (work: WagerProcessingUnitOfWork) => new ProcessWagerTransaction(work), inject: [WagerProcessingUnitOfWork] },
      ],
      exports: [ProcessWagerTransaction, WagerTransactionIdentity],
    };
  }
}
