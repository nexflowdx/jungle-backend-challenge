import { Module, type DynamicModule } from '@nestjs/common';
import { OpenWallet } from './application/open-wallet';
import { WalletOpeningUnitOfWork } from './application/wallet-opening-unit-of-work';
import { ReadWalletLedger, WalletLedgerReader } from './application/read-wallet-ledger';

@Module({})
export class WalletsModule {
  /** Composition supplies an initialized persistence adapter; bootstrap needs no database. */
  static register(unitOfWork: WalletOpeningUnitOfWork, ledgerReader?: WalletLedgerReader): DynamicModule {
    return {
      module: WalletsModule,
      providers: [
        { provide: WalletOpeningUnitOfWork, useValue: unitOfWork },
        { provide: OpenWallet, useFactory: (work: WalletOpeningUnitOfWork) => new OpenWallet(work), inject: [WalletOpeningUnitOfWork] },
        ...(ledgerReader ? [
          { provide: WalletLedgerReader, useValue: ledgerReader },
          { provide: ReadWalletLedger, useFactory: (reader: WalletLedgerReader) => new ReadWalletLedger(reader), inject: [WalletLedgerReader] },
        ] : []),
      ],
      exports: [OpenWallet, ...(ledgerReader ? [ReadWalletLedger] : [])],
    };
  }
}
