import type { WagerTransactionKind } from '../domain/wager-transaction.types';
import { WagerProcessingUnitOfWork } from './wager-processing-unit-of-work';

/** Provisional internal command; transport contracts belong to later increments. */
export interface ProcessWagerTransactionCommand {
  readonly walletId: string;
  readonly kind: WagerTransactionKind;
}

export class WagerProcessingNotImplementedError extends Error {
  readonly code = 'WAGER_PROCESSING_NOT_IMPLEMENTED';

  constructor(readonly kind: WagerTransactionKind) {
    super('Wager processing is not implemented');
    this.name = 'WagerProcessingNotImplementedError';
  }
}

export class ProcessWagerTransaction {
  // Reserved for the following increments; unavailable operations never call this port.
  constructor(private readonly unitOfWork: WagerProcessingUnitOfWork) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<never> {
    throw new WagerProcessingNotImplementedError(command.kind);
  }
}
