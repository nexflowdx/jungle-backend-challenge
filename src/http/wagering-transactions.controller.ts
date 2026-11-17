import { Body, Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ProcessWagerTransaction } from '../modules/wagering/application/process-wager-transaction';
import { WagerTransactionStatus as Status } from '../modules/wagering/domain/wager-transaction.types';
import { ProviderAuthenticationGuard } from './provider-authentication.guard';
import { idempotencyKey, WagerRequestPipe, type WagerRequest } from './request-validation';
import type { HttpResponse } from './http-error.filter';

@Controller('wagering/transactions')
@UseGuards(ProviderAuthenticationGuard)
export class WageringTransactionsController {
  constructor(@Inject(ProcessWagerTransaction) private readonly processTransaction: ProcessWagerTransaction) {}
  @Post()
  @HttpCode(200)
  async create(@Body(WagerRequestPipe) request: WagerRequest, @Req() transport: IncomingMessage, @Res({ passthrough: true }) response: HttpResponse) {
    const result = await this.processTransaction.execute({ ...request, idempotencyKey: idempotencyKey(transport), correlationId: randomUUID() });
    response.status(result.status === Status.PendingReference ? 202 : result.status === Status.Rejected ? 422 : 200);
    return result;
  }
}
