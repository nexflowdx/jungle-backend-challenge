import { Body, Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { ProcessWagerTransaction } from '../modules/wagering/application/process-wager-transaction';
import { WagerTransactionStatus as Status } from '../modules/wagering/domain/wager-transaction.types';
import { ProviderAuthenticationGuard } from './provider-authentication.guard';
import { idempotencyKey, WagerRequestPipe, type WagerRequest } from './request-validation';
import type { HttpResponse } from './http-error.filter';
import { JsonLogger, jsonLogger } from '../modules/operations/json-logger';
import { httpCorrelationId } from './correlation.middleware';
import { operationalMetrics } from '../modules/operations/operational-metrics';

@Controller('wagering/transactions')
@UseGuards(ProviderAuthenticationGuard)
export class WageringTransactionsController {
  constructor(@Inject(ProcessWagerTransaction) private readonly processTransaction: ProcessWagerTransaction,
    @Inject(JsonLogger) private readonly logger: JsonLogger = jsonLogger) {}
  @Post()
  @HttpCode(200)
  async create(@Body(WagerRequestPipe) request: WagerRequest, @Req() transport: IncomingMessage, @Res({ passthrough: true }) response: HttpResponse) {
    const command = { ...request, idempotencyKey: idempotencyKey(transport), correlationId: httpCorrelationId() };
    const result = await operationalMetrics.measureProcessing(() => this.processTransaction.execute(command));
    operationalMetrics.observeWager(result);
    this.logger.emit('info', 'wager.completed', { transactionId: result.transactionId, walletId: request.walletId, providerId: request.providerId });
    response.status(result.status === Status.PendingReference ? 202 : result.status === Status.Rejected ? 422 : 200);
    return result;
  }
}
