import type { ProcessWagerTransaction } from '../../wagering/application/process-wager-transaction';
import { wagerMessageIdentity } from './wager-message-identity';
import { parseWagerTransactionRequested } from './wager-requested';
import { JsonLogger, jsonLogger } from '../../operations/json-logger';
import { runWithLogContext } from '../../operations/log-context';
import { operationalMetrics } from '../../operations/operational-metrics';

/** Explicit dispatch with atomic inbox; the caller may ACK only after this promise resolves. */
export class SqsWagerCommandHandler {
  constructor(private readonly processTransaction: Pick<ProcessWagerTransaction, 'execute'>, private readonly logger: JsonLogger = jsonLogger) {}
  execute(envelope: unknown) {
    const request = parseWagerTransactionRequested(envelope);
    return runWithLogContext({ correlationId: request.messageId, messageId: request.messageId,
      walletId: request.data.walletId, providerId: request.data.providerId }, async () => {
      try {
        const result = await operationalMetrics.measureProcessing(() => this.processTransaction.execute(
          { ...request.data, correlationId: request.messageId, causationId: request.messageId }, wagerMessageIdentity(request)));
        operationalMetrics.observeWager(result);
        this.logger.emit('info', 'sqs.command_committed', { transactionId: result.transactionId });
        return result;
      } catch (error) {
        this.logger.emit('error', 'sqs.command_failed');
        throw error;
      }
    });
  }
}
