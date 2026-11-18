import { expect, test } from 'bun:test';
import { DomainError } from '../../src/shared/domain/domain-error';
import { InvalidMoneyAmountError } from '../../src/shared/domain/money.errors';
import {
  WagerProcessingNotImplementedError, WagerResultUnavailableError, WagerWalletNotFoundError,
  type ProcessWagerTransactionResult,
} from '../../src/modules/wagering/application/process-wager-transaction';
import { WagerProcessingRetryableError } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { WagerIdentityCollisionError, WagerIdentityConflictError } from '../../src/modules/wagering/application/wager-transaction-identity';
import { WagerInboxConflictError } from '../../src/modules/wagering/application/wager-inbox';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { InvalidWagerMessageError } from '../../src/modules/messaging/application/wager-requested';
import {
  classifyWagerFailure, decideWagerDelivery, isWagerReceiveLimitExhausted, wagerRetryDelaySeconds,
  type WagerDeliveryFailure, type WagerFailurePhase, type WagerFinancialOutcome,
} from '../../src/modules/messaging/application/wager-delivery-policy';

const phases: readonly WagerFailurePhase[] = ['validation', 'processing', 'commit', 'dlq', 'ack'];
const retryable = () => new WagerProcessingRetryableError('40001', new Error('serialization failure'));
const failure = (error: unknown, phase: WagerFailurePhase = 'processing', financialOutcome: WagerFinancialOutcome = { kind: 'rolled-back' }): WagerDeliveryFailure =>
  ({ phase, error, financialOutcome });
const decide = (value: WagerDeliveryFailure, receiveCount = 1) => decideWagerDelivery({ kind: 'failure', failure: value }, receiveCount, 0.5);
const result = (status: ProcessWagerTransactionResult['status']): ProcessWagerTransactionResult => Object.freeze({
  transactionId: 'transaction', status, balance: Object.freeze({ amount: '75.00', currency: 'BRL' }), idempotentReplay: false,
  ...(status === Status.Rejected ? { failureCode: FailureCode.InsufficientFunds } : {}),
});

test('invalid message before processing is permanent, never a business ACK', () => {
  const value = failure(new InvalidWagerMessageError(), 'validation', { kind: 'not-started' });
  expect(classifyWagerFailure(value).category).toBe('permanent');
  expect(decide(value)).toMatchObject({ action: 'send-to-dlq', exhausted: false });
});

test.each([
  new WagerIdentityConflictError('PAYLOAD_MISMATCH'), new WagerInboxConflictError(),
  new WagerWalletNotFoundError(), new WagerProcessingNotImplementedError(Kind.Opening),
])('known processing failure %# is permanent only with safe financial evidence', error => {
  expect(decide(failure(error))).toMatchObject({ action: 'send-to-dlq', failure: { category: 'permanent' } });
  expect(decide(failure(error, 'processing', { kind: 'uncertain' }), 5)).toMatchObject({ action: 'hold', failure: { category: 'uncertain' } });
});

test.each(['40P01', '40001'] as const)('exhausted internal SQL retry %s allows SQS retry only after confirmed rollback', sqlState => {
  const error = new WagerProcessingRetryableError(sqlState, undefined);
  expect(decide(failure(error))).toMatchObject({ action: 'retry', delaySeconds: 2, exhausted: false, failure: { category: 'transient' } });
  expect(decide(failure(error, 'commit'))).toMatchObject({ action: 'retry' });
});

test('identity collision propagated after rollback is transient', () => {
  expect(decide(failure(new WagerIdentityCollisionError('idempotency-key')))).toMatchObject({ action: 'retry', failure: { category: 'transient' } });
});

test.each([1, 2, 3, 4])('receipt %i remains eligible for retry', receiveCount => {
  expect(isWagerReceiveLimitExhausted(receiveCount)).toBe(false);
  expect(decide(failure(retryable()), receiveCount)).toMatchObject({ action: 'retry', exhausted: false });
});

test.each([5, 6, 100])('receipt %i exhausts known transient failures but never authorizes source deletion', receiveCount => {
  expect(isWagerReceiveLimitExhausted(receiveCount)).toBe(true);
  expect(decide(failure(retryable()), receiveCount)).toMatchObject({ action: 'send-to-dlq', exhausted: true });
});

test('backoff doubles from the first SQS receipt and caps at 60 seconds', () => {
  expect([1, 2, 3, 4, 5, 6, 7, Number.MAX_SAFE_INTEGER].map(count => wagerRetryDelaySeconds(count, 0.5)))
    .toEqual([2, 4, 8, 16, 32, 60, 60, 60]);
});

test('injected jitter is symmetric, deterministic and at most 20 percent', () => {
  expect(wagerRetryDelaySeconds(1, 0)).toBeCloseTo(1.6);
  expect(wagerRetryDelaySeconds(1, 1)).toBeCloseTo(2.4);
  expect(wagerRetryDelaySeconds(4, 0.25)).toBeCloseTo(14.4);
  expect(wagerRetryDelaySeconds(5, 1)).toBeCloseTo(38.4);
  expect(decideWagerDelivery({ kind: 'failure', failure: failure(retryable()) }, 1, 0)).toMatchObject({ delaySeconds: 1.6 });
  for (const count of [6, 7, 100, Number.MAX_SAFE_INTEGER]) {
    for (const sample of [0, 0.25, 0.5, 0.75, 1]) expect(wagerRetryDelaySeconds(count, sample)).toBeLessThanOrEqual(60);
  }
});

test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('invalid receipt count %s cannot produce an operational decision', count => {
  expect(() => isWagerReceiveLimitExhausted(count)).toThrow(RangeError);
  expect(() => wagerRetryDelaySeconds(count, 0.5)).toThrow(RangeError);
  expect(() => decide(failure(retryable()), count)).toThrow(RangeError);
});

test.each([-0.1, 1.1, NaN, Infinity])('invalid jitter sample %s is rejected', sample => {
  expect(() => wagerRetryDelaySeconds(1, sample)).toThrow(RangeError);
});

test.each(phases)('unknown errors in %s preserve phase and never authorize ACK or DLQ', phase => {
  for (const error of [new Error('unknown'), null, undefined, 'timeout', { code: '40001' }, { name: 'TimeoutError' }]) {
    for (const count of [1, 5, 6]) {
      const value = failure(error, phase);
      expect(decide(value, count)).toMatchObject({ action: 'hold', failure: { phase, category: 'uncertain', financialOutcome: { kind: 'rolled-back' } } });
      expect(classifyWagerFailure(value).error).toBe(error);
    }
  }
});

test.each([
  new DomainError('INSUFFICIENT_FUNDS', 'Thrown, not persisted'), new DomainError('UNKNOWN', 'Unknown invariant'),
  new InvalidMoneyAmountError(), new WagerResultUnavailableError(),
])('domain or unavailable result error %# is not a persisted business outcome', error => {
  expect(decide(failure(error), 5)).toMatchObject({ action: 'hold', failure: { category: 'uncertain' } });
});

test.each(phases)('uncertain financial outcome overrides familiar errors in %s, including at exhaustion', phase => {
  for (const error of [retryable(), new InvalidWagerMessageError(), new WagerIdentityConflictError('EXTERNAL_ID_REUSED')]) {
    for (const count of [1, 5, 6]) {
      const decision = decide(failure(error, phase, { kind: 'uncertain' }), count);
      expect(decision).toMatchObject({ action: 'hold', failure: { category: 'uncertain', financialOutcome: { kind: 'uncertain' } } });
      expect('delaySeconds' in decision).toBe(false);
    }
  }
});

test('a commit timeout cannot turn a callback result into evidence of rollback or persistence', () => {
  const callbackResult = result(Status.Processed);
  expect(callbackResult.status).toBe(Status.Processed);
  expect(decide(failure(new Error('connection lost during COMMIT'), 'commit', { kind: 'uncertain' }), 5))
    .toMatchObject({ action: 'hold', exhausted: true, failure: { category: 'uncertain' } });
});

test.each([Status.Processed, Status.Rejected, Status.PendingReference] as const)('confirmed %s is durable, even at exhaustion', status => {
  const persisted = result(status);
  for (const receiveCount of [1, 5, 6]) {
    expect(decideWagerDelivery({ kind: 'persisted', result: persisted }, receiveCount, 0.5)).toEqual({ action: 'ack', result: persisted });
  }
});

test.each([Status.Processed, Status.Rejected, Status.PendingReference] as const)('ACK failure preserves durable %s and never retries financial processing', status => {
  const persisted = result(status);
  const error = new Error('DeleteMessage failed after commit');
  const decision = decide(failure(error, 'ack', { kind: 'persisted', result: persisted }), 5);
  expect(decision).toMatchObject({ action: 'hold', failure: { phase: 'ack', category: 'uncertain', financialOutcome: { kind: 'persisted', result: persisted } } });
  if (decision.action !== 'hold') throw new Error('Expected conservative hold');
  expect(decision.failure.error).toBe(error);
  expect(decision.failure.financialOutcome).toEqual({ kind: 'persisted', result: persisted });
});

test.each(phases)('known SQL errors do not leak a financial retry decision into inappropriate phase %s', phase => {
  const decision = decide(failure(retryable(), phase, { kind: 'persisted', result: result(Status.Processed) }), 5);
  expect(decision.action).toBe('hold');
  if (phase !== 'processing' && phase !== 'commit') expect(decide(failure(retryable(), phase), 5).action).toBe('hold');
});

test('invalid-message and identity errors cannot bypass phase-specific classification', () => {
  expect(decide(failure(new InvalidWagerMessageError(), 'commit'), 5).action).toBe('hold');
  expect(decide(failure(new WagerIdentityCollisionError('provider-external'), 'commit'), 5).action).toBe('hold');
  expect(decide(failure(retryable(), 'commit', { kind: 'not-started' }), 5).action).toBe('hold');
});
