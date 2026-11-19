import { Body, Controller, Get, HttpCode, Inject, Optional, Param, Post, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { OpenWallet } from '../modules/wallets/application/open-wallet';
import { ProviderAuthenticationGuard } from './provider-authentication.guard';
import { WalletRequestPipe, type WalletRequest } from './request-validation';
import { ReadWalletLedger } from '../modules/wallets/application/read-wallet-ledger';
import { WalletLedgerAccessGuard } from './wallet-ledger-access.guard';
import { ReconcileWallet } from '../modules/wallets/application/reconcile-wallet';
import { JsonLogger, jsonLogger } from '../modules/operations/json-logger';
import { httpCorrelationId } from './correlation.middleware';

@Controller('wallets')
@UseGuards(ProviderAuthenticationGuard)
export class WalletsController {
  constructor(@Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Optional() @Inject(ReadWalletLedger) private readonly readLedger?: ReadWalletLedger,
    @Optional() @Inject(ReconcileWallet) private readonly reconcileWallet?: ReconcileWallet,
    @Optional() @Inject(JsonLogger) private readonly logger: JsonLogger = jsonLogger) {}
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  @UseGuards(WalletLedgerAccessGuard)
  async reconcile(@Param('walletId') walletId: string) {
    if (!this.reconcileWallet) throw new ServiceUnavailableException();
    return this.reconcileWallet.execute(walletId);
  }
  @Get(':walletId/ledger')
  @UseGuards(WalletLedgerAccessGuard)
  async ledger(@Param('walletId') walletId: string, @Query() query: Record<string, unknown>) {
    if (!this.readLedger) throw new ServiceUnavailableException();
    return this.readLedger.execute(walletId, query);
  }
  @Post()
  @HttpCode(201)
  async create(@Body(WalletRequestPipe) request: WalletRequest) {
    const result = await this.openWallet.execute({ ...request, correlationId: httpCorrelationId() });
    this.logger.emit('info', 'wallet.opened', { walletId: result.id });
    return result;
  }
}
