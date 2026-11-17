import { describe, expect, test } from 'bun:test';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { LedgerDirection } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import {
  FailureCode, InvalidTransactionStateError, WagerTransactionKind as Kind, WagerTransactionStatus as Status,
} from '../../src/modules/wagering/domain/wager-transaction.types';
import { at, later, money, process, transaction, transactionProps, wallet } from './financial-fixtures';

describe('WagerTransaction creation (2.3)', () => {
  test.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])('creates %s in PENDING', (kind) => {
    const tx = transaction({ kind, referenceExternalTransactionId: 'reference' });
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.requiresReference()).toBe(kind === Kind.Refund || kind === Kind.Rollback);
    expect(tx.affectsBalance()).toBe(kind !== Kind.Loss);
    expect(tx.balance).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])('rejects zero %s', (kind) => {
    expect(() => transaction({ kind, money: money('0.00'), referenceExternalTransactionId: 'reference' })).toThrow();
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])('rejects negative %s', (kind) => {
    expect(() => transaction({ kind, money: money('0.01').negate(), referenceExternalTransactionId: 'reference' })).toThrow();
  });

  test('accepts zero LOSS', () => { expect(transaction({ kind: Kind.Loss, money: money('0.00') }).money.isZero()).toBe(true); });

  test.each([Kind.Refund, Kind.Rollback])('requires an external reference for %s', (kind) => {
    expect(() => transaction({ kind })).toThrow();
    expect(() => transaction({ kind, referenceExternalTransactionId: '' })).toThrow();
  });

  test('keeps OPENING behind an explicit internal factory', () => {
    expect(() => transaction({ kind: Kind.Opening })).toThrow('internal');
    const props = transactionProps();
    const opening = WagerTransaction.createOpening(props);
    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.status).toBe(Status.Pending);
    expect(() => process(opening, wallet())).toThrow('Opening');
    expect(() => WagerTransaction.createOpening({ ...props, money: money('0.00') })).toThrow();
    opening.markProcessed(undefined, money('10.00'), later);
    expect(opening.status).toBe(Status.Processed);
  });

  test('rejects invalid kind, identifiers and date', () => {
    expect(() => transaction({ kind: 'OTHER' as Kind })).toThrow();
    expect(() => transaction({ walletId: ' ' })).toThrow();
    expect(() => transaction({ createdAt: new Date(NaN) })).toThrow();
  });

  test('compares payload hashes exactly without changing identity', () => {
    const tx = transaction({ payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('ABC')).toBe(false);
    expect(tx.matchesPayload('other')).toBe(false);
    expect(tx.status).toBe(Status.Pending);
  });
});

describe('WagerTransaction state machine (2.3)', () => {
  for (const initial of [Status.Pending, Status.PendingReference]) {
    test.each(['process', 'reject', 'fail', 'pending'] as const)(`${initial} permits %s`, (action) => {
      const tx = transaction({ kind: Kind.Win, referenceExternalTransactionId: 'bet' });
      if (initial === Status.PendingReference) tx.markPendingReference(money('100.00'));
      if (action === 'process') tx.markProcessed('bet-id', money('110.00'), later);
      if (action === 'reject') tx.reject(FailureCode.ReferenceNotFound, money('100.00'), later);
      if (action === 'fail') tx.fail(FailureCode.PermanentInfrastructureFailure, money('100.00'), later);
      if (action === 'pending') tx.markPendingReference(money('100.00'));
      const expected = { process: Status.Processed, reject: Status.Rejected, fail: Status.Failed, pending: Status.PendingReference };
      expect(tx.status).toBe(expected[action]);
      expect(tx.isTerminal()).toBe(action !== 'pending');
      expect(tx.completedAt).toEqual(action === 'pending' ? undefined : later);
      expect(tx.processedAt).toEqual(action === 'process' ? later : undefined);
    });
  }

  for (const initial of [Status.Processed, Status.Rejected, Status.Failed]) {
    test.each(['process', 'reject', 'fail', 'pending', 'apply'] as const)(`${initial} blocks %s and freezes its result`, (action) => {
      const tx = WagerTransaction.rehydrate({
        ...transactionProps({ kind: Kind.Win, referenceExternalTransactionId: 'bet' }),
        status: initial, balance: money('110.00'), completedAt: later,
        ...(initial === Status.Processed ? { referenceTransactionId: 'bet-id' } : { failureCode: FailureCode.ReferenceNotFound }),
      });
      const target = wallet();
      const actions = {
        process: () => tx.markProcessed('other', money('999.00'), at),
        reject: () => tx.reject(FailureCode.AlreadyReversed, money('999.00'), at),
        fail: () => tx.fail(FailureCode.PermanentInfrastructureFailure, money('999.00'), at),
        pending: () => tx.markPendingReference(money('999.00')),
        apply: () => process(tx, target),
      };
      expect(actions[action]).toThrow(InvalidTransactionStateError);
      expect(tx.status).toBe(initial);
      expect(tx.balance?.toString()).toBe('110.00');
      expect(tx.completedAt).toEqual(later);
      expect(target.balance.toString()).toBe('100.00');
      expect(target.pendingLedgerEntries).toHaveLength(1);
    });
  }

  test('preserves the first pending snapshot until the historical terminal result', () => {
    const tx = transaction({ kind: Kind.Win, referenceExternalTransactionId: 'bet' });
    tx.markPendingReference(money('100.00'));
    tx.markPendingReference(money('999.00'));
    expect(tx.balance?.toString()).toBe('100.00');
    tx.markProcessed('bet-id', money('110.00'), later);
    expect(tx.balance?.toString()).toBe('110.00');
    expect(tx.acceptedBalance?.toString()).toBe('100.00');
  });

  test('invalid transitions and metadata leave state unchanged', () => {
    const tx = transaction();
    expect(() => tx.markPendingReference(money('100.00'))).toThrow(InvalidTransactionStateError);
    expect(() => tx.markProcessed('unexpected-ref', money('90.00'), later)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markProcessed(undefined, money('0.01').negate(), later)).toThrow();
    expect(() => tx.markProcessed(undefined, money('90.00', 'USD'), later)).toThrow();
    expect(() => tx.markProcessed(undefined, money('90.00'), new Date(NaN))).toThrow();
    expect(() => tx.reject('UNKNOWN' as FailureCode, money('100.00'), later)).toThrow();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.balance).toBeUndefined();
    const referenced = transaction({ kind: Kind.Win, referenceExternalTransactionId: 'bet' });
    expect(() => referenced.markProcessed(undefined, money('110.00'), later)).toThrow();
  });

  test('rehydrates persisted fields without invoking creation or state transitions', () => {
    const tx = WagerTransaction.rehydrate({
      ...transactionProps({ kind: Kind.Opening }), status: Status.Processed, balance: money('10.00'), completedAt: later,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.balance?.toString()).toBe('10.00');
    expect(tx.completedAt).toEqual(later);
    expect(() => tx.markProcessed(undefined, money('10.00'), later)).toThrow(InvalidTransactionStateError);
  });

  test('protects immutable fields and mutable dates', () => {
    const createdAt = new Date(at);
    const completedAt = new Date(later);
    const tx = transaction({ createdAt });
    tx.markProcessed(undefined, money('90.00'), completedAt);
    createdAt.setTime(0);
    completedAt.setTime(0);
    tx.createdAt.setTime(0);
    tx.completedAt?.setTime(0);
    expect(tx.createdAt).toEqual(at);
    expect(tx.completedAt).toEqual(later);
    expect(Reflect.set(tx, 'kind', Kind.Win)).toBe(false);
    expect(Reflect.set(tx, 'status', Status.Pending)).toBe(false);
  });
});

describe('Transaction financial behavior', () => {
  test.each([[Kind.Bet, '90.00', LedgerDirection.Debit], [Kind.Win, '110.00', LedgerDirection.Credit]] as const)(
    '%s produces exactly one movement', (kind, balance, direction) => {
      const target = wallet();
      const tx = transaction({ kind });
      const entry = process(tx, target);
      expect(tx.status).toBe(Status.Processed);
      expect(target.balance.toString()).toBe(balance);
      expect(tx.balance?.toString()).toBe(balance);
      expect(target.version).toBe(2);
      expect(target.pendingLedgerEntries).toHaveLength(2);
      expect(entry?.direction).toBe(direction);
      expect(() => process(tx, target)).toThrow(InvalidTransactionStateError);
      target.credit({ id: 'later', transactionId: 'later', money: money('1.00'), at: later });
      expect(tx.balance?.toString()).toBe(balance);
    },
  );

  test.each(['0.00', '10.00'])('LOSS %s records the result without balance, version, timestamp or ledger changes', (amount) => {
    const target = wallet();
    const tx = transaction({ kind: Kind.Loss, money: money(amount) });
    expect(tx.ledgerDirectionFor()).toBeUndefined();
    expect(process(tx, target)).toBeUndefined();
    expect(tx.status).toBe(Status.Processed);
    expect(tx.balance?.toString()).toBe('100.00');
    expect(target.version).toBe(1);
    expect(target.updatedAt).toEqual(at);
    expect(target.pendingLedgerEntries).toHaveLength(1);
  });

  test.each([
    ['0.00', '10.00', Kind.Bet, FailureCode.InsufficientFunds],
    ['92233720368547758.07', '0.01', Kind.Win, FailureCode.AmountLimitExceeded],
  ] as const)('rejects %s balance / %s %s with %s and no movement', (balance, amount, kind, code) => {
    const target = wallet(balance);
    const entries = target.pendingLedgerEntries.length;
    const tx = transaction({ kind, money: money(amount) });
    expect(process(tx, target)).toBeUndefined();
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(code);
    expect(tx.balance?.toString()).toBe(balance);
    expect(target.balance.toString()).toBe(balance);
    expect(target.version).toBe(1);
    expect(target.pendingLedgerEntries).toHaveLength(entries);
  });

  test('rejects incompatible currencies without changing the wallet', () => {
    const target = wallet();
    const tx = transaction({ money: money('10.00', 'USD') });
    process(tx, target);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(tx.balance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(target.version).toBe(1);
    expect(target.pendingLedgerEntries).toHaveLength(1);
  });

  test('technical routing and ledger errors remain errors with no partial effect', () => {
    for (const overrides of [{ walletId: 'other' }, { playerId: 'other' }]) {
      const target = wallet();
      const tx = transaction(overrides);
      expect(() => process(tx, target)).toThrow();
      expect(tx.status).toBe(Status.Pending);
      expect(target.version).toBe(1);
    }
    const target = wallet();
    const tx = transaction();
    expect(() => tx.process(target, { at: later, priorReversals: [] })).toThrow();
    expect(tx.status).toBe(Status.Pending);
    expect(target.version).toBe(1);
  });
});
