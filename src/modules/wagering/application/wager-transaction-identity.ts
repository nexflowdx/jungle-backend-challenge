import { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionStatus } from '../domain/wager-transaction.types';
import { WagerRequestFingerprint, type WagerIdentityRequest } from './wager-request-fingerprint';
import type { WagerProcessingTransaction, WagerProcessingUnitOfWork } from './wager-processing-unit-of-work';

export interface WagerIdentityKey {
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
}

export interface WagerIdentityOutcome {
  readonly kind: 'identity-created' | 'identity-replay';
  readonly transactionId: string;
  readonly payloadHash: string;
}

/** Emitted by persistence only after rollback of one of the two identity UNIQUE constraints. */
export class WagerIdentityCollisionError extends Error {
  readonly code = 'WAGER_IDENTITY_COLLISION';
  constructor(readonly source: 'idempotency-key' | 'provider-external') {
    super('Concurrent wager identity collision');
    this.name = 'WagerIdentityCollisionError';
  }
}

export class WagerIdentityConflictError extends Error {
  readonly code = 'WAGER_IDENTITY_CONFLICT';
  constructor(readonly reason: 'PAYLOAD_MISMATCH' | 'EXTERNAL_ID_REUSED' | 'CROSSED_IDENTITIES') {
    super('Wager identity conflicts with an existing transaction');
    this.name = 'WagerIdentityConflictError';
  }
}

export class WagerTransactionIdentity {
  createCandidate(request: WagerIdentityRequest, id: string, at: Date): WagerTransaction {
    const fingerprint = WagerRequestFingerprint.from(request);
    return WagerTransaction.create({ ...fingerprint.business, id, createdAt: at,
      idempotencyKey: fingerprint.idempotencyKey, payloadHash: fingerprint.payloadHash, money: fingerprint.money });
  }

  /** No transaction/commit of its own; the caller owns the complete unit of work. */
  async resolve(candidate: WagerTransaction, scope: WagerProcessingTransaction): Promise<WagerIdentityOutcome> {
    if (candidate.status !== WagerTransactionStatus.Pending) throw new Error('Identity candidate must be PENDING');
    const existing = await scope.findIdentityCandidates(candidate);
    const replay = this.classify(candidate, existing);
    if (replay) return replay;
    await scope.insertPending(candidate);
    return Object.freeze({ kind: 'identity-created', transactionId: candidate.id, payloadHash: candidate.payloadHash });
  }

  /** Call outside the failed transaction. Generic database errors are never identity conflicts. */
  async recoverAfterRollback(candidate: WagerTransaction, error: unknown, work: WagerProcessingUnitOfWork): Promise<WagerIdentityOutcome> {
    if (!(error instanceof WagerIdentityCollisionError)) throw error;
    return work.transaction(async scope => {
      const replay = this.classify(candidate, await scope.findIdentityCandidates(candidate));
      if (!replay) throw error;
      return replay;
    });
  }

  private classify(candidate: WagerTransaction, existing: readonly WagerTransaction[]): WagerIdentityOutcome | undefined {
    if (existing.length === 0) return undefined;
    if (existing.length > 1) throw new WagerIdentityConflictError('CROSSED_IDENTITIES');
    const stored = existing[0]!;
    if (stored.idempotencyKey !== candidate.idempotencyKey) throw new WagerIdentityConflictError('EXTERNAL_ID_REUSED');
    if (stored.providerId !== candidate.providerId || stored.externalTransactionId !== candidate.externalTransactionId
      || !stored.matchesPayload(candidate.payloadHash)) throw new WagerIdentityConflictError('PAYLOAD_MISMATCH');
    return Object.freeze({ kind: 'identity-replay', transactionId: stored.id, payloadHash: stored.payloadHash });
  }
}
