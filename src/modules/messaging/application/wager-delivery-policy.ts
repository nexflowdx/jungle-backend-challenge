import type { ProcessWagerTransactionResult } from '../../wagering/application/process-wager-transaction';
import { WagerWalletNotFoundError, WagerProcessingNotImplementedError } from '../../wagering/application/process-wager-transaction';
import { WagerProcessingRetryableError } from '../../wagering/application/wager-processing-unit-of-work';
import { WagerIdentityCollisionError, WagerIdentityConflictError } from '../../wagering/application/wager-transaction-identity';
import { WagerInboxConflictError } from '../../wagering/application/wager-inbox';
import { InvalidWagerMessageError } from './wager-requested';

export type WagerFailurePhase = 'validation' | 'processing' | 'commit' | 'dlq' | 'ack';
export type WagerFailureCategory = 'transient' | 'permanent' | 'uncertain';

/** Evidence supplied by the future adapter, never inferred from a thrown error.
 * A callback result is not persisted evidence: the enclosing commit must be confirmed.
 */
export type WagerFinancialOutcome =
  | { readonly kind: 'not-started' | 'rolled-back' | 'uncertain' }
  | { readonly kind: 'persisted'; readonly result: ProcessWagerTransactionResult };

export interface WagerDeliveryFailure {
  readonly phase: WagerFailurePhase;
  readonly error: unknown;
  readonly financialOutcome: WagerFinancialOutcome;
}

export type WagerDeliveryObservation =
  | { readonly kind: 'persisted'; readonly result: ProcessWagerTransactionResult }
  | { readonly kind: 'failure'; readonly failure: WagerDeliveryFailure };

export interface ClassifiedWagerFailure extends WagerDeliveryFailure {
  readonly category: WagerFailureCategory;
}

export type WagerDeliveryDecision =
  | { readonly action: 'ack'; readonly result: ProcessWagerTransactionResult }
  | { readonly action: 'hold'; readonly failure: ClassifiedWagerFailure; readonly exhausted: boolean }
  | { readonly action: 'retry'; readonly failure: ClassifiedWagerFailure; readonly exhausted: false; readonly delaySeconds: number }
  // Eligibility only. A future adapter must confirm DLQ publication before deleting the source.
  | { readonly action: 'send-to-dlq'; readonly failure: ClassifiedWagerFailure; readonly exhausted: boolean };

export const MAX_WAGER_RECEIVE_COUNT = 5;

function assertReceiveCount(receiveCount: number): void {
  if (!Number.isSafeInteger(receiveCount) || receiveCount < 1) throw new RangeError('SQS receive count must be a positive safe integer');
}

export function isWagerReceiveLimitExhausted(receiveCount: number): boolean {
  assertReceiveCount(receiveCount);
  return receiveCount >= MAX_WAGER_RECEIVE_COUNT;
}

/** Pure calculation: the caller supplies a sample in [0, 1], with 0.5 disabling jitter.
 * First receipt uses 2 seconds; symmetric jitter is at most 20%; final delay never exceeds 60.
 */
export function wagerRetryDelaySeconds(receiveCount: number, jitterSample: number): number {
  assertReceiveCount(receiveCount);
  if (!Number.isFinite(jitterSample) || jitterSample < 0 || jitterSample > 1) throw new RangeError('Jitter sample must be in [0, 1]');
  const exponential = 2 * 2 ** Math.min(receiveCount - 1, 6);
  return Math.min(60, exponential * (1 + (jitterSample * 2 - 1) * 0.2));
}

export function classifyWagerFailure(failure: WagerDeliveryFailure): ClassifiedWagerFailure {
  const { error, phase, financialOutcome } = failure;
  let category: WagerFailureCategory = 'uncertain';
  // Neither exhaustion nor an apparently familiar error proves that a commit rolled back.
  if (financialOutcome.kind !== 'uncertain') {
    if (phase === 'validation' && financialOutcome.kind === 'not-started' && error instanceof InvalidWagerMessageError) {
      category = 'permanent';
    } else if ((phase === 'processing' || phase === 'commit') && financialOutcome.kind === 'rolled-back'
      && (error instanceof WagerProcessingRetryableError || (phase === 'processing' && error instanceof WagerIdentityCollisionError))) {
      category = 'transient';
    } else if (phase === 'processing' && (financialOutcome.kind === 'not-started' || financialOutcome.kind === 'rolled-back')
      && (error instanceof WagerIdentityConflictError || error instanceof WagerInboxConflictError
        || error instanceof WagerWalletNotFoundError || error instanceof WagerProcessingNotImplementedError)) {
      category = 'permanent';
    }
  }
  // Generic DomainError, raw database/SDK errors and transport failures stay uncertain.
  return Object.freeze({ ...failure, category });
}

/** No I/O, financial state changes, FAILED persistence, SQL retry or consumer wiring. */
export function decideWagerDelivery(observation: WagerDeliveryObservation, receiveCount: number, jitterSample: number): WagerDeliveryDecision {
  const exhausted = isWagerReceiveLimitExhausted(receiveCount);
  if (observation.kind === 'persisted') return Object.freeze({ action: 'ack', result: observation.result });
  const failure = classifyWagerFailure(observation.failure);
  if (failure.category === 'uncertain' || failure.financialOutcome.kind === 'persisted'
    || failure.phase === 'ack' || failure.phase === 'dlq') return Object.freeze({ action: 'hold', failure, exhausted });
  if (failure.category === 'permanent' || exhausted) return Object.freeze({ action: 'send-to-dlq', failure, exhausted });
  return Object.freeze({ action: 'retry', failure, exhausted: false, delaySeconds: wagerRetryDelaySeconds(receiveCount, jitterSample) });
}
