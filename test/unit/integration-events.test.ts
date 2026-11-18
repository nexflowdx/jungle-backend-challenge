import { describe, expect, test } from 'bun:test';
import {
  IntegrationEvent, type IntegrationEventProps, type EventContext,
} from '../../src/shared/domain/integration-event';
import { WalletBalanceChanged } from '../../src/modules/wallets/domain/wallet-balance-changed';
import { WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import {
  createTransactionEvents, WagerTransactionFailed, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected,
} from '../../src/modules/wagering/domain/wagering.events';
import { FailureCode, WagerTransactionKind as Kind } from '../../src/modules/wagering/domain/wager-transaction.types';
import { at, later, money, process, transaction, transactionProps, wallet } from './financial-fixtures';

const context = (): EventContext => ({ eventId: 'event', correlationId: 'correlation', causationId: 'request', occurredAt: later });

class TestEvent<T> extends IntegrationEvent<T> {
  readonly eventType = 'TestEvent';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<T>) { super(props); Object.freeze(this); }
  static create<T>(data: T, ctx: EventContext = context()): TestEvent<T> {
    return new TestEvent({ ...ctx, aggregateId: 'wallet', data });
  }
}

describe('IntegrationEvent envelope and immutability (2.5)', () => {
  test('serializes the stable envelope including causation, ISO date and version', () => {
    const event = TestEvent.create({ money: money('9007199254740993.01').toJSON() });
    expect(event.toJSON()).toEqual({
      eventId: 'event', eventType: 'TestEvent', aggregateId: 'wallet', correlationId: 'correlation', causationId: 'request',
      occurredAt: later.toISOString(), version: 1, data: { money: { amount: '9007199254740993.01', currency: 'BRL' } },
    });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
    expect(JSON.stringify(event)).toBe(JSON.stringify(event));
  });

  test('omits absent optional causation instead of serializing undefined', () => {
    const event = TestEvent.create({}, { eventId: 'event', correlationId: 'correlation', occurredAt: at });
    expect(Object.hasOwn(event.toJSON(), 'causationId')).toBe(false);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  test('copies and freezes nested input data, arrays, envelope and dates', () => {
    const props = { money: { amount: '10.00', currency: 'BRL' }, items: [{ label: 'original' }] };
    const occurredAt = new Date(later);
    const event = TestEvent.create(props, { ...context(), occurredAt });
    props.money.amount = '99.00';
    props.items[0]!.label = 'changed';
    occurredAt.setTime(0);
    event.occurredAt.setTime(0);
    expect(event.data.money.amount).toBe('10.00');
    expect(event.data.items[0]?.label).toBe('original');
    expect(event.occurredAt).toEqual(later);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    expect(Object.isFrozen(event.data.items)).toBe(true);
    expect(Object.isFrozen(event.toJSON())).toBe(true);
    expect(Reflect.set(event.data.money, 'amount', '99.00')).toBe(false);
    expect(Reflect.set(event, 'version', 2)).toBe(false);
  });

  test.each([money('1.00'), 1n, new Date(), undefined, NaN, Infinity, () => {}].map((value) => [value] as const))(
    'rejects non-JSON event data %s', (value) => { expect(() => TestEvent.create({ value })).toThrow(); },
  );

  test.each([
    { eventId: '' }, { correlationId: ' ' }, { causationId: '' }, { occurredAt: new Date(NaN) },
  ])('rejects invalid envelope metadata (%j)', (overrides) => {
    expect(() => TestEvent.create({}, { ...context(), ...overrides })).toThrow();
  });
});

describe('Concrete financial events (2.5)', () => {
  test('processed BET produces the transaction event and one exact balance event', () => {
    const target = wallet();
    const tx = transaction();
    const entry = process(tx, target);
    let sequence = 0;
    const events = createTransactionEvents(tx, target, entry, () => ({ ...context(), eventId: `event-${++sequence}` }));
    expect(events).toHaveLength(2);
    expect(events[0]).toBeInstanceOf(WagerTransactionProcessed);
    expect(events[1]).toBeInstanceOf(WalletBalanceChanged);
    expect(events.map((event) => event.eventId)).toEqual(['event-1', 'event-2']);
    expect(events.map((event) => event.version)).toEqual([1, 1]);
    expect(events[0]?.aggregateId).toBe(target.id);
    expect(events[1]?.data).toEqual({
      walletId: target.id, transactionId: tx.id, direction: 'DEBIT', money: money('10.00').toJSON(),
      balanceBefore: money('100.00').toJSON(), balanceAfter: money('90.00').toJSON(), walletVersion: 2,
    });
    for (const event of events) expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
    expect(Object.isFrozen(events)).toBe(true);
  });

  test.each(['0.00', '10.00'])('LOSS %s emits only WagerTransactionProcessed', (amount) => {
    const target = wallet();
    const tx = transaction({ kind: Kind.Loss, money: money(amount) });
    const entry = process(tx, target);
    const events = createTransactionEvents(tx, target, entry, context);
    expect(events.map((event) => event.eventType)).toEqual(['WagerTransactionProcessed']);
    expect(target.version).toBe(1);
    expect(target.pendingLedgerEntries).toHaveLength(1);
  });

  test('business rejection emits its stable failureCode with no balance event', () => {
    const target = wallet('0.00');
    const tx = transaction();
    const entry = process(tx, target);
    const events = createTransactionEvents(tx, target, entry, context);
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(WagerTransactionRejected);
    expect((events[0] as WagerTransactionRejected).data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(JSON.parse(JSON.stringify(events[0]))).toEqual(events[0]?.toJSON());
  });

  test('currency rejection preserves requested money and actual wallet balance currencies', () => {
    const target = wallet();
    const tx = transaction({ money: money('10.00', 'USD') });
    process(tx, target);
    const event = WagerTransactionRejected.from(tx, context());
    expect(event.data.money.currency).toBe('USD');
    expect(event.data.balance.currency).toBe('BRL');
    expect(event.data.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  test('failed expiration emits one immutable failure event without a balance event', () => {
    const target = wallet();
    const tx = transaction({ kind: Kind.Win, referenceExternalTransactionId: 'missing-bet' });
    tx.markPendingReference(target.balance);
    expect(() => WagerTransactionFailed.from(tx, context())).toThrow();
    tx.fail(FailureCode.ReferenceNotFound, target.balance, later);
    const events = createTransactionEvents(tx, target, undefined, context);
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(WagerTransactionFailed);
    expect(events[0]!.toJSON()).toMatchObject({
      eventType: 'WagerTransactionFailed', aggregateId: target.id, version: 1,
      data: { status: 'FAILED', failureCode: FailureCode.ReferenceNotFound, balance: target.balance.toJSON() },
    });
    expect(Object.isFrozen(events[0]!.data)).toBe(true);
  });

  test('pending-reference event remains a stable acceptance snapshot after transaction completion', () => {
    const target = wallet();
    const bet = transaction();
    const refund = transaction({ kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });
    process(refund, target);
    const events = createTransactionEvents(refund, target, undefined, context);
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(WagerTransactionPendingReference);
    const serialized = JSON.stringify(events[0]);
    process(bet, target);
    const entry = process(refund, target, bet);
    expect(JSON.stringify(events[0])).toBe(serialized);
    const processed = createTransactionEvents(refund, target, entry, context);
    expect(processed).toHaveLength(2);
    expect((processed[0] as WagerTransactionProcessed).data.referenceTransactionId).toBe(bet.id);
    expect((processed[0] as WagerTransactionProcessed).data.referenceExternalTransactionId).toBe(bet.externalTransactionId);
  });

  test('OPENING uses the initial credit at version 1', () => {
    const target = wallet('100.00');
    const tx = WagerTransaction.createOpening(transactionProps({ id: 'opening-transaction', money: money('100.00') }));
    tx.markProcessed(undefined, target.balance, at);
    const events = createTransactionEvents(tx, target, target.pendingLedgerEntries[0], context);
    expect(events).toHaveLength(2);
    expect((events[1] as WalletBalanceChanged).data.walletVersion).toBe(1);
  });

  test.each(['processed', 'rejected', 'pending'] as const)('prevents %s event in the wrong state', (type) => {
    const tx = transaction();
    const factories = {
      processed: () => WagerTransactionProcessed.from(tx, context()),
      rejected: () => WagerTransactionRejected.from(tx, context()),
      pending: () => WagerTransactionPendingReference.from(tx, context()),
    };
    expect(factories[type]).toThrow();
  });

  test('rejects missing/extra, unrelated and stale ledger entries', () => {
    const target = wallet();
    const bet = transaction();
    const entry = process(bet, target)!;
    expect(() => createTransactionEvents(bet, target, undefined, context)).toThrow();
    const unrelated = WalletLedgerEntry.rehydrate({
      ...entry, id: 'unrelated', walletId: 'other', transactionId: bet.id, createdAt: entry.createdAt,
    });
    expect(() => WalletBalanceChanged.from(target, unrelated, context())).toThrow();
    const loss = transaction({ kind: Kind.Loss });
    process(loss, target);
    expect(() => createTransactionEvents(loss, target, entry, context)).toThrow();
    const another = transaction();
    process(another, target);
    expect(() => WalletBalanceChanged.from(target, entry, context())).toThrow();
    expect(() => createTransactionEvents(another, target, entry, context)).toThrow();
  });

  test('events keep historical money and version after further wallet movements', () => {
    const target = wallet('9007199254740993.01');
    const tx = transaction({ kind: Kind.Win, money: money('0.01') });
    const entry = process(tx, target)!;
    const event = WalletBalanceChanged.from(target, entry, context());
    const serialized = JSON.stringify(event);
    process(transaction(), target);
    expect(event.data.balanceAfter.amount).toBe('9007199254740993.02');
    expect(event.data.walletVersion).toBe(2);
    expect(JSON.stringify(event)).toBe(serialized);
  });
});
