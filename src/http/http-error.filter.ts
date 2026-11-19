import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ConnectionException } from '@mikro-orm/core';
import { DomainError } from '../shared/domain/domain-error';
import { WalletAlreadyExistsError } from '../modules/wallets/application/wallet-opening-unit-of-work';
import { WagerIdentityCollisionError, WagerIdentityConflictError } from '../modules/wagering/application/wager-transaction-identity';
import { WagerProcessingRetryableError } from '../modules/wagering/application/wager-processing-unit-of-work';
import { WagerProcessingNotImplementedError, WagerResultUnavailableError, WagerWalletNotFoundError } from '../modules/wagering/application/process-wager-transaction';
import { InvalidLedgerQueryError, LedgerWalletNotFoundError } from '../modules/wallets/application/read-wallet-ledger';

export interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
}
function transient(error: unknown): boolean {
  if (error instanceof ConnectionException || error instanceof WagerProcessingRetryableError
    || error instanceof WagerResultUnavailableError || error instanceof WagerIdentityCollisionError) return true;
  if (error instanceof Error && error.name === 'KnexTimeoutError') return true;
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return false;
  return /^08[0-9A-Z]{3}$/.test(error.code) || ['40P01', '40001', '55P03', '57014', '57P01', '57P02', '57P03', '53300',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(error.code);
}
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    if (error instanceof LedgerWalletNotFoundError) { response.status(404).json({ code: 'WALLET_NOT_FOUND', message: 'Wallet not found' }); return; }
    if (error instanceof WalletAlreadyExistsError) { response.status(409).json({ code: error.code, message: 'Wallet already exists' }); return; }
    if (error instanceof WagerIdentityConflictError) { response.status(409).json({ code: error.code, reason: error.reason, message: 'Transaction identity conflict' }); return; }
    if (transient(error) || error instanceof HttpException && error.getStatus() === 503) { response.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unable to process request' }); return; }
    if (error instanceof WagerWalletNotFoundError || error instanceof DomainError) {
      response.status(422).json({ code: 'BUSINESS_RULE_REJECTED', failureCode: error.code }); return;
    }
    if (error instanceof InvalidLedgerQueryError || error instanceof WagerProcessingNotImplementedError || error instanceof HttpException && error.getStatus() === 400) {
      response.status(400).json({ code: 'INVALID_REQUEST', message: 'Invalid request' }); return;
    }
    if (error instanceof HttpException && error.getStatus() < 500) {
      response.status(error.getStatus()).json({ code: 'HTTP_ERROR', message: 'Request could not be handled' }); return;
    }
    // Neither driver messages, SQL, stack traces nor connection details cross this boundary.
    response.status(500).json({ code: 'INTERNAL_ERROR', message: 'Unable to process request' });
  }
}
