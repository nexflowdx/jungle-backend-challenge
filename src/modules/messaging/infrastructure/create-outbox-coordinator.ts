import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxPublicationCoordinator } from '../application/outbox-publication-coordinator';
import { PostgresOutboxReservation } from './postgres-outbox-reservation';
import { PostgresOutboxConfirmation } from './postgres-outbox-confirmation';
import { PostgresOutboxRetry } from './postgres-outbox-retry';
import { SqsOutboxPublisher, type SqsOutboxSendClient } from './sqs-outbox-publisher';

export function createOutboxCoordinator(
  orm: MikroORM,
  sqs: SqsOutboxSendClient,
  queueUrl: string,
): OutboxPublicationCoordinator {
  return new OutboxPublicationCoordinator(
    new PostgresOutboxReservation(orm),
    new SqsOutboxPublisher(sqs, queueUrl),
    new PostgresOutboxConfirmation(orm),
    new PostgresOutboxRetry(orm),
  );
}
