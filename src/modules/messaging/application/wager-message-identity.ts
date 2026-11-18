import { createHash } from 'node:crypto';
import { WagerRequestFingerprint } from '../../wagering/application/wager-request-fingerprint';
import type { WagerInboxIdentity } from '../../wagering/application/wager-inbox';
import type { WagerTransactionRequested } from './wager-requested';

export const wagerConsumerName = 'wager-transactions';
/** Versioned canonical projection: sorted business JSON, exact key, normalized UTC timestamp and event type. */
export function wagerMessageIdentity(request: WagerTransactionRequested): WagerInboxIdentity {
  const fingerprint = WagerRequestFingerprint.from(request.data);
  const canonical = `{"business":${fingerprint.canonicalJson},"idempotencyKey":${JSON.stringify(fingerprint.idempotencyKey)},"occurredAt":${JSON.stringify(new Date(request.occurredAt).toISOString())},"type":${JSON.stringify(request.type)},"version":"1"}`;
  return Object.freeze({ messageId: request.messageId, consumerName: wagerConsumerName,
    payloadHash: createHash('sha256').update(canonical, 'utf8').digest('hex') });
}
