export interface OutboxReservationOptions {
  readonly limit: number;
  readonly leaseSeconds?: number;
}

export interface ReservedOutboxEvent {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly publishedAt: Date | null;
  readonly leaseToken: string;
  readonly leaseUntil: Date;
}

export class InvalidOutboxReservationError extends Error {
  readonly code = 'INVALID_OUTBOX_RESERVATION';

  constructor(readonly field: string) {
    super(`Invalid outbox reservation parameter: ${field}`);
    this.name = 'InvalidOutboxReservationError';
  }
}

export function outboxReservationParameters(
  options: OutboxReservationOptions,
): Readonly<Required<OutboxReservationOptions>> {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw new InvalidOutboxReservationError('limit');
  }

  const leaseSeconds = options.leaseSeconds === undefined
    ? 30
    : options.leaseSeconds;

  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < 1 ||
    leaseSeconds > 3600
  ) {
    throw new InvalidOutboxReservationError('leaseSeconds');
  }

  return Object.freeze({
    limit: options.limit,
    leaseSeconds,
  });
}

export abstract class OutboxReservation {
  abstract reserve(
    options: OutboxReservationOptions,
  ): Promise<readonly ReservedOutboxEvent[]>;
}
