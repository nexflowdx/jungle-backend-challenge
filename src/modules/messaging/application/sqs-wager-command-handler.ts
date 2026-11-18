import type { ProcessWagerTransaction } from '../../wagering/application/process-wager-transaction';
import { wagerMessageIdentity } from './wager-message-identity';
import { parseWagerTransactionRequested } from './wager-requested';

/** Explicit dispatch with atomic inbox; the caller may ACK only after this promise resolves. */
export class SqsWagerCommandHandler {
  constructor(private readonly processTransaction: Pick<ProcessWagerTransaction, 'execute'>) {}
  execute(envelope: unknown) {
    const request = parseWagerTransactionRequested(envelope);
    return this.processTransaction.execute({ ...request.data, correlationId: request.messageId, causationId: request.messageId }, wagerMessageIdentity(request));
  }
}
