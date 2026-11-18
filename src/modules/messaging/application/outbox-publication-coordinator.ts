import type {
  OutboxReservation,
  ReservedOutboxEvent,
} from './outbox-reservation';

export interface OutboxEventPublisher {
  publish(
    event: ReservedOutboxEvent,
    abortSignal?: AbortSignal,
  ): Promise<unknown>;
}

export interface OutboxEventConfirmation {
  confirm(eventId: string, leaseToken: string): Promise<boolean>;
}

export interface OutboxEventRetry {
  schedule(
    eventId: string,
    leaseToken: string,
    delaySeconds: number,
  ): Promise<boolean>;
}

export type OutboxProcessingResult =
  | { status: 'empty' }
  | { status: 'published'; eventId: string }
  | { status: 'retry-scheduled'; eventId: string; delaySeconds: number }
  | { status: 'lease-lost'; eventId: string }
  | { status: 'retry-not-scheduled'; eventId: string };

export class OutboxPublicationCoordinator {
  constructor(
    private readonly reservation: OutboxReservation,
    private readonly publisher: OutboxEventPublisher,
    private readonly confirmation: OutboxEventConfirmation,
    private readonly retry: OutboxEventRetry,
    private readonly random: () => number = Math.random,
  ) {}

  async processOnce(): Promise<OutboxProcessingResult> {
    const events = await this.reservation.reserve({
      limit: 1,
      leaseSeconds: 30,
    });

    const event = events[0];

    if (!event) {
      return { status: 'empty' };
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Outbox publication deadline exceeded'));
      }, 10_000);
    });

    try {
      await Promise.race([
        this.publisher.publish(event, controller.signal),
        deadline,
      ]);
    } catch {
      if (timeout !== undefined) clearTimeout(timeout);

      const delaySeconds = this.retryDelay(event.attempts);

      const scheduled = await this.retry.schedule(
        event.id,
        event.leaseToken,
        delaySeconds,
      );

      return scheduled
        ? { status: 'retry-scheduled', eventId: event.id, delaySeconds }
        : { status: 'retry-not-scheduled', eventId: event.id };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    const confirmed = await this.confirmation.confirm(
      event.id,
      event.leaseToken,
    );

    return confirmed
      ? { status: 'published', eventId: event.id }
      : { status: 'lease-lost', eventId: event.id };
  }

  private retryDelay(attempts: number): number {
    const exponent = Math.min(Math.max(attempts - 1, 0), 6);
    const ceiling = Math.min(60, 2 ** exponent);
    const jitter = this.random();

    if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) {
      throw new Error('Invalid retry jitter');
    }

    return Math.max(1, Math.floor(jitter * ceiling) + 1);
  }
}
