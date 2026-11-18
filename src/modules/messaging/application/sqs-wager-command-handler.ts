import type { ProcessWagerTransaction } from '../../wagering/application/process-wager-transaction';
import { parseWagerTransactionRequested } from './wager-requested';

/** Explicit dispatch only; not a consumer and not an acknowledgement boundary. */
export class SqsWagerCommandHandler {
  constructor(private readonly processTransaction: Pick<ProcessWagerTransaction, 'execute'>) {}
  execute(envelope: unknown) {
    const request = parseWagerTransactionRequested(envelope);
    return this.processTransaction.execute({ ...request.data, correlationId: request.messageId, causationId: request.messageId });
  }
}
