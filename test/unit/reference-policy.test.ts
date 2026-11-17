import { describe, expect, test } from 'bun:test';
import { ReferencePolicy } from '../../src/modules/wagering/domain/reference-policy';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import {
  type CreateWagerTransactionProps, FailureCode, WagerTransactionKind as Kind, WagerTransactionStatus as Status,
} from '../../src/modules/wagering/domain/wager-transaction.types';
import { LedgerDirection } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import { at, later, money, process, reference, transaction, transactionProps, wallet } from './financial-fixtures';

describe('Reference matrix and context (2.4)', () => {
  for (const kind of [Kind.Win, Kind.Refund, Kind.Rollback]) {
    test.each(Object.values(Kind))(`${kind} referencing processed %s`, (referenceKind) => {
      const ref = reference(referenceKind);
      const target = wallet();
      const tx = transaction({ kind, referenceExternalTransactionId: ref.externalTransactionId });
      const allowed = kind === Kind.Rollback ? [Kind.Bet, Kind.Win, Kind.Refund].includes(referenceKind) : referenceKind === Kind.Bet;
      const entry = process(tx, target, ref);
      if (allowed) {
        const debit = kind === Kind.Rollback && referenceKind !== Kind.Bet;
        expect(tx.status).toBe(Status.Processed);
        expect(tx.referenceTransactionId).toBe(ref.id);
        expect(entry?.direction).toBe(debit ? LedgerDirection.Debit : LedgerDirection.Credit);
        expect(target.balance.toString()).toBe(debit ? '90.00' : '110.00');
        expect(tx.ledgerDirectionFor(ref)).toBe(entry?.direction);
        expect(target.version).toBe(2);
      } else {
        expect(tx.status).toBe(Status.Rejected);
        expect(tx.failureCode).toBe(FailureCode.ReferenceKindInvalid);
        expect(entry).toBeUndefined();
        expect(target.balance.toString()).toBe('100.00');
        expect(target.version).toBe(1);
      }
    });
  }

  test.each([
    { providerId: 'other' }, { externalTransactionId: 'other' }, { playerId: 'other' },
    { walletId: 'other' }, { money: money('10.00', 'USD') }, { roundId: 'other' },
  ] satisfies Partial<CreateWagerTransactionProps>[] )('rejects mismatched reference context (%j)', (overrides) => {
    const ref = reference(Kind.Bet, { externalTransactionId: 'original-bet', ...overrides });
    const tx = transaction({ kind: Kind.Refund, referenceExternalTransactionId: 'original-bet' });
    const target = wallet();
    expect(process(tx, target, ref)).toBeUndefined();
    expect(tx.failureCode).toBe(FailureCode.ReferenceContextMismatch);
    expect(target.balance.toString()).toBe('100.00');
    expect(target.pendingLedgerEntries).toHaveLength(1);
  });

  test('does not add an unapproved gameId restriction', () => {
    const ref = reference(Kind.Bet, { gameId: 'another-game' });
    const tx = transaction({ kind: Kind.Refund, referenceExternalTransactionId: ref.externalTransactionId });
    process(tx, wallet(), ref);
    expect(tx.status).toBe(Status.Processed);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s requires an exact full amount, including a one-cent difference', (kind) => {
    const ref = reference();
    for (const amount of ['9.99', '10.01']) {
      const target = wallet();
      const tx = transaction({ kind, money: money(amount), referenceExternalTransactionId: ref.externalTransactionId });
      process(tx, target, ref);
      expect(tx.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
      expect(target.version).toBe(1);
    }
  });

  test('WIN can differ in amount from its referenced BET', () => {
    const ref = reference();
    const target = wallet();
    const tx = transaction({ kind: Kind.Win, money: money('123.45'), referenceExternalTransactionId: ref.externalTransactionId });
    process(tx, target, ref);
    expect(tx.status).toBe(Status.Processed);
    expect(target.balance.toString()).toBe('223.45');
  });

  test.each([Kind.Win, Kind.Refund, Kind.Rollback])('%s rejects self-reference even when not resolved', (kind) => {
    const target = wallet();
    const tx = transaction({ kind, externalTransactionId: 'same', referenceExternalTransactionId: 'same' });
    process(tx, target);
    expect(tx.failureCode).toBe(FailureCode.SelfReference);
    expect(target.version).toBe(1);
  });

  test.each([
    [Status.Rejected, FailureCode.ReferenceRejected], [Status.Failed, FailureCode.ReferenceFailed],
  ] as const)('rejects dependent of %s reference with %s', (status, code) => {
    const ref = WagerTransaction.rehydrate({ ...transactionProps(), status, failureCode: FailureCode.InsufficientFunds, balance: money('0.00'), completedAt: at });
    const tx = transaction({ kind: Kind.Refund, referenceExternalTransactionId: ref.externalTransactionId });
    const target = wallet();
    process(tx, target, ref);
    expect(tx.failureCode).toBe(code);
    expect(target.pendingLedgerEntries).toHaveLength(1);
  });
});

describe('Out-of-order references and reversal policy (2.4)', () => {
  test.each([Kind.Win, Kind.Refund, Kind.Rollback])('%s waits for absent reference and later applies once', (kind) => {
    const target = wallet('200.00');
    const bet = transaction({ money: money('100.00') });
    const dependent = transaction({ kind, money: money('100.00'), referenceExternalTransactionId: bet.externalTransactionId });
    expect(process(dependent, target)).toBeUndefined();
    expect(dependent.status).toBe(Status.PendingReference);
    expect(dependent.balance?.toString()).toBe('200.00');
    expect(target.version).toBe(1);
    expect(target.pendingLedgerEntries).toHaveLength(1);
    process(bet, target);
    process(dependent, target, bet);
    expect(dependent.status).toBe(Status.Processed);
    expect(dependent.acceptedBalance?.toString()).toBe('200.00');
    expect(dependent.balance?.toString()).toBe('200.00');
    expect(target.balance.toString()).toBe('200.00');
    expect(target.version).toBe(3);
    expect(target.pendingLedgerEntries).toHaveLength(3);
    expect(() => process(dependent, target, bet)).toThrow();
    expect(target.pendingLedgerEntries).toHaveLength(3);
  });

  test.each([Status.Pending, Status.PendingReference])('waits for reference in %s', (status) => {
    const ref = WagerTransaction.rehydrate({ ...transactionProps(), status });
    const tx = transaction({ kind: Kind.Refund, referenceExternalTransactionId: ref.externalTransactionId });
    const target = wallet();
    process(tx, target, ref);
    expect(tx.status).toBe(Status.PendingReference);
    expect(target.version).toBe(1);
    expect(() => tx.ledgerDirectionFor(ref)).toThrow();
  });

  test.each([Kind.Refund, Kind.Rollback])('blocks a second processed %s over the same reference', (kind) => {
    const ref = reference();
    const target = wallet();
    const first = transaction({ kind, referenceExternalTransactionId: ref.externalTransactionId });
    process(first, target, ref);
    const second = transaction({ kind, referenceExternalTransactionId: ref.externalTransactionId });
    process(second, target, ref, [first]);
    expect(first.status).toBe(Status.Processed);
    expect(second.status).toBe(Status.Rejected);
    expect(second.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(target.balance.toString()).toBe('110.00');
    expect(target.version).toBe(2);
    expect(target.pendingLedgerEntries).toHaveLength(2);
  });

  test.each([Status.Rejected, Status.Failed, Status.Pending, Status.PendingReference])('%s reversal does not consume a reversal of the same type', (status) => {
    const ref = reference();
    const previous = WagerTransaction.rehydrate({
      ...transactionProps({ kind: Kind.Refund, referenceExternalTransactionId: ref.externalTransactionId }), status,
    });
    const tx = transaction({ kind: Kind.Refund, referenceExternalTransactionId: ref.externalTransactionId });
    process(tx, wallet(), ref, [previous]);
    expect(tx.status).toBe(Status.Processed);
  });

  test.each([[Kind.Refund, Kind.Rollback], [Kind.Rollback, Kind.Refund]] as const)(
    'allows crossed reversals %s then %s and reconstructs 300.00 from the ledger', (firstKind, secondKind) => {
      const target = wallet('200.00');
      const bet = transaction({ money: money('100.00') });
      process(bet, target);
      const first = transaction({ kind: firstKind, money: bet.money, referenceExternalTransactionId: bet.externalTransactionId });
      process(first, target, bet);
      const second = transaction({ kind: secondKind, money: bet.money, referenceExternalTransactionId: bet.externalTransactionId });
      process(second, target, bet, [first]);
      expect([bet.status, first.status, second.status]).toEqual([Status.Processed, Status.Processed, Status.Processed]);
      expect(target.balance.toString()).toBe('300.00');
      const reconstructed = target.pendingLedgerEntries.reduce((sum, entry) =>
        entry.direction === LedgerDirection.Credit ? sum.add(entry.money) : sum.subtract(entry.money), money('0.00'));
      expect(reconstructed.equals(target.balance)).toBe(true);
      expect(target.pendingLedgerEntries).toHaveLength(4);
      for (const tx of [bet, first, second]) expect(() => process(tx, target, bet, [first, second])).toThrow();
      expect(target.balance.toString()).toBe('300.00');
    },
  );

  test.each([Kind.Win, Kind.Refund])('ROLLBACK of %s debits, with a distinct insufficient-funds code', (kind) => {
    const ref = reference(kind);
    const target = wallet('9.99');
    const rollback = transaction({ kind: Kind.Rollback, referenceExternalTransactionId: ref.externalTransactionId });
    process(rollback, target, ref);
    expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(target.balance.toString()).toBe('9.99');
    expect(target.pendingLedgerEntries).toHaveLength(1);
    target.credit({ id: 'topup', transactionId: 'topup', money: money('0.01'), at: later });
    const next = transaction({ kind: Kind.Rollback, referenceExternalTransactionId: ref.externalTransactionId });
    process(next, target, ref, [rollback]);
    expect(next.status).toBe(Status.Processed);
    expect(target.balance.isZero()).toBe(true);
    expect(target.version).toBe(3);
    expect(target.pendingLedgerEntries).toHaveLength(3);
  });

  test('ROLLBACK of an applied REFUND restores the pre-refund balance with an inverse ledger entry', () => {
    const target = wallet('200.00');
    const bet = transaction({ money: money('100.00') });
    process(bet, target);
    const refund = transaction({ kind: Kind.Refund, money: bet.money, referenceExternalTransactionId: bet.externalTransactionId });
    const refundEntry = process(refund, target, bet)!;
    const rollback = transaction({ kind: Kind.Rollback, money: refund.money, referenceExternalTransactionId: refund.externalTransactionId });
    const rollbackEntry = process(rollback, target, refund, [refund])!;
    expect(rollback.status).toBe(Status.Processed);
    expect(rollbackEntry.direction).toBe(LedgerDirection.Debit);
    expect(rollbackEntry.balanceAfter.equals(refundEntry.balanceBefore)).toBe(true);
    expect(target.balance.toString()).toBe('100.00');
    expect(target.version).toBe(4);
    const reconstructed = target.pendingLedgerEntries.reduce((sum, entry) =>
      entry.direction === LedgerDirection.Credit ? sum.add(entry.money) : sum.subtract(entry.money), money('0.00'));
    expect(reconstructed.equals(target.balance)).toBe(true);
  });

  test('resolves provider-scoped identity, ignoring reversals belonging to another provider', () => {
    const ref = reference(Kind.Bet, { externalTransactionId: 'shared' });
    const other = reference(Kind.Refund, { providerId: 'other-provider', referenceExternalTransactionId: 'shared' });
    const tx = transaction({ kind: Kind.Refund, referenceExternalTransactionId: 'shared' });
    expect(ReferencePolicy.resolve(tx, ref, [other]).pending).toBe(false);
  });

  test('a pending transaction can expire with the approved reference-not-found failure', () => {
    const tx = transaction({ kind: Kind.Refund, referenceExternalTransactionId: 'absent' });
    const target = wallet();
    process(tx, target);
    tx.reject(FailureCode.ReferenceNotFound, target.balance, later);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(target.version).toBe(1);
  });
});
