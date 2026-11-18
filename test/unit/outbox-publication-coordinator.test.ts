import { describe, expect, mock, test } from 'bun:test';
import type {
  OutboxReservation,
  ReservedOutboxEvent,
} from '../../src/modules/messaging/application/outbox-reservation';
import {
  OutboxPublicationCoordinator,
} from '../../src/modules/messaging/application/outbox-publication-coordinator';

const event: ReservedOutboxEvent = {
  id: 'event-123',
  aggregateId: 'wallet-456',
  eventType: 'WagerAccepted',
  eventVersion: 1,
  payload: { amount: 100 },
  occurredAt: new Date('2026-11-18T10:00:00Z'),
  attempts: 1,
  nextAttemptAt: null,
  publishedAt: null,
  leaseToken: 'lease-789',
  leaseUntil: new Date('2026-11-18T10:00:30Z'),
};

function fixture(events: readonly ReservedOutboxEvent[] = [event]) {
  const reserve = mock(async () => events);
  const publish = mock(async (
    _event: ReservedOutboxEvent,
    _abortSignal?: AbortSignal,
  ) => ({ eventId: event.id }));
  const confirm = mock(async () => true);
  const schedule = mock(async () => true);

  const coordinator = new OutboxPublicationCoordinator(
    { reserve } as unknown as OutboxReservation,
    { publish },
    { confirm },
    { schedule },
    () => 0.5,
  );

  return { coordinator, reserve, publish, confirm, schedule };
}

describe('Outbox publication coordinator', () => {
  test('does nothing when there are no eligible events', async () => {
    const f = fixture([]);

    expect(await f.coordinator.processOnce()).toEqual({
      status: 'empty',
    });

    expect(f.reserve).toHaveBeenCalledWith({
      limit: 1,
      leaseSeconds: 30,
    });

    expect(f.publish).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.schedule).not.toHaveBeenCalled();
  });

  test('publishes and confirms using the reserved lease token', async () => {
    const f = fixture();

    expect(await f.coordinator.processOnce()).toEqual({
      status: 'published',
      eventId: event.id,
    });

    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0]![0]).toEqual(event);
    expect(f.publish.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);

    expect(f.confirm).toHaveBeenCalledWith(
      event.id,
      event.leaseToken,
    );

    expect(f.schedule).not.toHaveBeenCalled();
  });

  test('schedules retry after SQS failure', async () => {
    const f = fixture();

    f.publish.mockImplementationOnce(async () => {
      throw new Error('SQS unavailable');
    });

    expect(await f.coordinator.processOnce()).toEqual({
      status: 'retry-scheduled',
      eventId: event.id,
      delaySeconds: 1,
    });

    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.schedule).toHaveBeenCalledWith(
      event.id,
      event.leaseToken,
      1,
    );
  });

  test('does not reschedule after publication if confirmation loses the lease', async () => {
    const f = fixture();

    f.confirm.mockImplementationOnce(async () => false);

    expect(await f.coordinator.processOnce()).toEqual({
      status: 'lease-lost',
      eventId: event.id,
    });

    expect(f.schedule).not.toHaveBeenCalled();
  });
});

test('database confirmation failure does not schedule immediate retry', async () => {
  const f = fixture();

  f.confirm.mockImplementationOnce(async () => {
    throw new Error('PostgreSQL unavailable');
  });

  await expect(f.coordinator.processOnce()).rejects.toThrow(
    'PostgreSQL unavailable',
  );

  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.confirm).toHaveBeenCalledTimes(1);
  expect(f.schedule).not.toHaveBeenCalled();
});

test('publication timeout aborts the request and schedules retry', async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;

  f.publish.mockImplementationOnce(async (_event, abortSignal) => {
    signal = abortSignal;
    return new Promise<{ eventId: string }>(() => {});
  });

  const started = Date.now();
  const result = await f.coordinator.processOnce();
  const elapsed = Date.now() - started;

  expect(result).toEqual({
    status: 'retry-scheduled',
    eventId: event.id,
    delaySeconds: 1,
  });

  expect(elapsed).toBeGreaterThanOrEqual(9_000);
  expect(elapsed).toBeLessThan(12_000);
  expect(signal?.aborted).toBe(true);
  expect(f.confirm).not.toHaveBeenCalled();
  expect(f.schedule).toHaveBeenCalledTimes(1);
}, 15_000);

test('retry delay grows exponentially and remains capped at 60 seconds', async () => {
  const cases = [
    { attempts: 1, expected: 1 },
    { attempts: 2, expected: 2 },
    { attempts: 3, expected: 4 },
    { attempts: 4, expected: 8 },
    { attempts: 5, expected: 16 },
    { attempts: 6, expected: 32 },
    { attempts: 7, expected: 60 },
    { attempts: 1000, expected: 60 },
  ];

  for (const { attempts, expected } of cases) {
    const f = fixture([{ ...event, attempts }]);

    f.publish.mockImplementationOnce(async () => {
      throw new Error('SQS unavailable');
    });

    const result = await f.coordinator.processOnce();

    expect(result.status).toBe('retry-scheduled');

    if (result.status === 'retry-scheduled') {
      expect(result.delaySeconds).toBeGreaterThanOrEqual(1);
      expect(result.delaySeconds).toBeLessThanOrEqual(expected);
    }

    expect(f.schedule).toHaveBeenCalledTimes(1);
  }
});

test('retry scheduling failure is reported without confirming publication', async () => {
  const f = fixture();

  f.publish.mockImplementationOnce(async () => {
    throw new Error('SQS unavailable');
  });

  f.schedule.mockImplementationOnce(async () => false);

  expect(await f.coordinator.processOnce()).toEqual({
    status: 'retry-not-scheduled',
    eventId: event.id,
  });

  expect(f.confirm).not.toHaveBeenCalled();
});
