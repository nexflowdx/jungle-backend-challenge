import { DomainError } from './domain-error';
import { assertIdentifier, timestamp } from './financial-rules';

export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  readonly aggregateId: string;
  readonly data: T;
}

export interface SerializedIntegrationEvent<T> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: Readonly<T>;
}

// Copy and freeze JSON data so callers cannot mutate nested money props or outbox payloads.
function immutableJson<T>(value: T): T {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJson)) as T;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableJson(item)]))) as T;
  }
  throw new DomainError('INVALID_EVENT_DATA', 'Event data must contain plain JSON values, with MoneyProps instead of Money');
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;
  readonly #occurredAt: number;

  protected constructor(props: IntegrationEventProps<T>) {
    for (const id of [props.eventId, props.aggregateId, props.correlationId]) assertIdentifier(id);
    if (props.causationId !== undefined) assertIdentifier(props.causationId);
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.#occurredAt = timestamp(props.occurredAt);
    this.data = immutableJson(props.data);
  }

  get occurredAt(): Date { return new Date(this.#occurredAt); }

  toJSON(): SerializedIntegrationEvent<T> {
    return Object.freeze({
      eventId: this.eventId, eventType: this.eventType, aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(), version: this.version, data: this.data,
    });
  }
}
