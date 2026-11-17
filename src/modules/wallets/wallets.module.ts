import { Module, type DynamicModule } from '@nestjs/common';
import { OpenWallet } from './application/open-wallet';
import { WalletOpeningUnitOfWork } from './application/wallet-opening-unit-of-work';

@Module({})
export class WalletsModule {
  /** Composition supplies an initialized persistence adapter; bootstrap needs no database. */
  static register(unitOfWork: WalletOpeningUnitOfWork): DynamicModule {
    return {
      module: WalletsModule,
      providers: [
        { provide: WalletOpeningUnitOfWork, useValue: unitOfWork },
        { provide: OpenWallet, useFactory: (work: WalletOpeningUnitOfWork) => new OpenWallet(work), inject: [WalletOpeningUnitOfWork] },
      ],
      exports: [OpenWallet],
    };
  }
}
