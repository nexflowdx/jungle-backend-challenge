import { Module, type DynamicModule } from '@nestjs/common';
import { OpenWallet } from './application/open-wallet';
import { WalletOpeningUnitOfWork } from './application/wallet-opening-unit-of-work';
import { ReadWalletLedger, WalletLedgerReader } from './application/read-wallet-ledger';
import { ReconcileWallet, WalletReconciliationSource } from './application/reconcile-wallet';

@Module({})
export class WalletsModule {
  /** Composition supplies an initialized persistence adapter; bootstrap needs no database. */
  static register(unitOfWork: WalletOpeningUnitOfWork, ledgerReader?: WalletLedgerReader, reconciliation?: WalletReconciliationSource): DynamicModule {
    return {
      module: WalletsModule,
      providers: [
        { provide: WalletOpeningUnitOfWork, useValue: unitOfWork },
        { provide: OpenWallet, useFactory: (work: WalletOpeningUnitOfWork) => new OpenWallet(work), inject: [WalletOpeningUnitOfWork] },
        ...(ledgerReader ? [
          { provide: WalletLedgerReader, useValue: ledgerReader },
          { provide: ReadWalletLedger, useFactory: (reader: WalletLedgerReader) => new ReadWalletLedger(reader), inject: [WalletLedgerReader] },
        ] : []),
        ...(reconciliation ? [
          { provide: WalletReconciliationSource, useValue: reconciliation },
          { provide: ReconcileWallet, useFactory: (source: WalletReconciliationSource) => new ReconcileWallet(source), inject: [WalletReconciliationSource] },
        ] : []),
      ],
      exports: [OpenWallet, ...(ledgerReader ? [ReadWalletLedger] : []), ...(reconciliation ? [ReconcileWallet] : [])],
    };
  }
}
