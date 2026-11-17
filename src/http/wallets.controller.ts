import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { OpenWallet } from '../modules/wallets/application/open-wallet';
import { ProviderAuthenticationGuard } from './provider-authentication.guard';
import { WalletRequestPipe, type WalletRequest } from './request-validation';

@Controller('wallets')
@UseGuards(ProviderAuthenticationGuard)
export class WalletsController {
  constructor(@Inject(OpenWallet) private readonly openWallet: OpenWallet) {}
  @Post()
  @HttpCode(201)
  async create(@Body(WalletRequestPipe) request: WalletRequest) {
    return this.openWallet.execute({ ...request, correlationId: randomUUID() });
  }
}
