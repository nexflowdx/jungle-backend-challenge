/** Transport-independent identity; never includes an SQS receipt handle or EntityManager. */
export interface WagerInboxIdentity {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
}
export interface WagerInboxTransaction {
  /** Reserves/locks one message before any wallet lock, on the financial SQL transaction. */
  claim(message: WagerInboxIdentity, receivedAt: Date): Promise<'unprocessed' | 'completed'>;
  complete(processedAt: Date): Promise<void>;
}
export class WagerInboxConflictError extends Error {
  readonly code = 'WAGER_INBOX_CONFLICT';
  constructor() { super('Message identity has incompatible content'); this.name = 'WagerInboxConflictError'; }
}
