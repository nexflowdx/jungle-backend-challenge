import { describe, expect, test } from 'bun:test';
import { walletMapper, transactionMapper } from '../../src/database/domain-mappers';
import { Money } from '../../src/shared/domain/money';
import type { IntegrationEvent } from '../../src/shared/domain/integration-event';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import type { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { ProcessWagerTransaction, WagerProcessingNotImplementedError, WagerResultUnavailableError, type SupportedWagerCommand } from '../../src/modules/wagering/application/process-wager-transaction';
import { WagerIdentityCollisionError, WagerTransactionIdentity } from '../../src/modules/wagering/application/wager-transaction-identity';
import { WagerProcessingRetryableError, WagerProcessingUnitOfWork, type WagerProcessingTransaction } from '../../src/modules/wagering/application/wager-processing-unit-of-work';

const at = new Date('2026-11-17T12:00:00.000Z');
const command = (kind: Kind.Win | Kind.Loss, overrides: Partial<SupportedWagerCommand> = {}): SupportedWagerCommand => ({
  referenceExternalTransactionId: 'reference', kind, walletId: 'wallet', playerId: 'player', providerId: 'provider', externalTransactionId: 'external',
  idempotencyKey: 'key', gameId: 'game', roundId: 'round', money: { amount: '25.00', currency: 'BRL' }, correlationId: 'correlation', ...overrides,
});

// Records application orchestration with the real domain. PostgreSQL tests prove database rollback.
class ReferenceWork extends WagerProcessingUnitOfWork {
  wallet = Wallet.open({ id: 'wallet', playerId: 'player', at, initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    opening: { id: 'opening', transactionId: 'opening-tx' } });
  rows = new Map<string, WagerTransaction>();
  ledger: WalletLedgerEntry[] = [];
  events: IntegrationEvent<unknown>[] = [];
  calls: string[] = [];
  failAt: string | undefined;
  retries = 0;
  override async transaction<T>(callback: (scope: WagerProcessingTransaction) => Promise<T>): Promise<T> {
    this.calls.push('begin');
    const wallet = walletMapper.toDomain(walletMapper.toRecord(this.wallet));
    const rows = new Map([...this.rows].map(([id, tx]) => [id, transactionMapper.toDomain(transactionMapper.toRecord(tx))]));
    const ledger = [...this.ledger]; const events = [...this.events];
    const step = (name: string) => { this.calls.push(name); if (this.failAt === name) throw new Error('injected failure'); };
    const result = await callback({
      lockWallet: async () => { step('lock'); return wallet; },
      findIdentityCandidates: async key => [...rows.values()].filter(tx => tx.idempotencyKey === key.idempotencyKey
        || (tx.providerId === key.providerId && tx.externalTransactionId === key.externalTransactionId)),
      insertPending: async tx => { step('pending'); rows.set(tx.id, transactionMapper.toDomain(transactionMapper.toRecord(tx))); },
      findReference: async (provider, external) => { step('reference'); return [...rows.values()].find(tx => tx.providerId === provider && tx.externalTransactionId === external); },
      loadTransaction: async id => rows.get(id),
      saveWallet: async () => { step('wallet'); },
      completeTransaction: async tx => { step('result'); rows.set(tx.id, transactionMapper.toDomain(transactionMapper.toRecord(tx))); },
      insertLedgerEntry: async entry => { step('ledger'); ledger.push(entry); },
      insertEvents: async newEvents => { step('outbox'); events.push(...newEvents); },
    });
    if (this.retries-- > 0) throw new WagerProcessingRetryableError('40001', new Error('serialization failure'));
    this.wallet = wallet; this.rows = rows; this.ledger = ledger; this.events = events; this.calls.push('commit');
    return result;
  }
}
function processor(work: ReferenceWork) {
  let id = 0;
  return new ProcessWagerTransaction(work, new WagerTransactionIdentity(), { newId: () => `id-${++id}`, now: () => at, retryDelay: async () => {} });
}

const input = (overrides: Partial<SupportedWagerCommand> = {}) => command(Kind.Win, overrides);
function fixture(work: ReferenceWork, overrides: Partial<ReturnType<typeof transactionMapper.toRecord>> = {}) {
  const { referenceExternalTransactionId: _reference, ...request } = input({ kind: Kind.Bet, externalTransactionId: 'reference', idempotencyKey: 'reference-key' });
  const tx = new WagerTransactionIdentity().createCandidate(request, 'reference-id', at);
  const row = transactionMapper.toRecord(tx);
  Object.assign(row, { status: Status.Processed, balance: '100.00', balanceCurrency: 'BRL', completedAt: at }, overrides);
  const reference = transactionMapper.toDomain(row); work.rows.set(reference.id, reference); return reference;
}

describe('WIN reference acceptance (5.5, domain orchestration)', () => {
  test('missing reference accepts durably without a financial effect', async () => {
    const work = new ReferenceWork(); const result = await processor(work).execute(input());
    expect(result).toMatchObject({ status: Status.PendingReference, balance: { amount: '100.00', currency: 'BRL' }, idempotentReplay: false });
    const stored = work.rows.get(result.transactionId)!;
    expect(stored.acceptedBalance!.toString()).toBe('100.00'); expect(stored.completedAt).toBeUndefined();
    expect(work.wallet.version).toBe(1); expect(work.ledger).toHaveLength(0);
    expect(work.calls).not.toContain('wallet'); expect(work.calls).not.toContain('ledger');
    expect(work.calls.indexOf('lock')).toBeLessThan(work.calls.indexOf('reference'));
    expect(work.events.map(event => event.eventType)).toEqual(['WagerTransactionPendingReference']);
    expect(work.events[0]!.occurredAt).toEqual(at);
  });
  test('pending replay preserves acceptance after wallet movement and reference arrival', async () => {
    const work = new ReferenceWork(); const useCase = processor(work); const first = await useCase.execute(input());
    const { referenceExternalTransactionId: _reference, ...bet } = input({ kind: Kind.Bet, idempotencyKey: 'reference-key', externalTransactionId: 'reference', money: { amount: '10.00', currency: 'BRL' } });
    await useCase.execute(bet);
    const events = work.events.length; work.calls = []; work.failAt = 'reference';
    expect(await useCase.execute(input())).toEqual({ ...first, idempotentReplay: true });
    expect(work.wallet.balance.toString()).toBe('90.00'); expect(work.events).toHaveLength(events);
    expect(work.calls).not.toContain('reference'); expect(work.ledger).toHaveLength(1);
  });
  test('post-rollback UNIQUE recovery returns the durable pending acceptance without reprocessing', async () => {
    const work = new ReferenceWork(); const first = await processor(work).execute(input()); let collided = false;
    const collision: WagerProcessingUnitOfWork = { transaction: callback => {
      if (!collided) { collided = true; return Promise.reject(new WagerIdentityCollisionError('idempotency-key')); }
      return work.transaction(callback);
    } };
    work.failAt = 'reference';
    expect(await new ProcessWagerTransaction(collision).execute(input())).toEqual({ ...first, idempotentReplay: true });
    expect(work.events).toHaveLength(1); expect(work.ledger).toHaveLength(0);
  });
  test('valid processed BET reference credits using the existing domain', async () => {
    const work = new ReferenceWork(); fixture(work);
    expect(await processor(work).execute(input())).toMatchObject({ status: Status.Processed, balance: { amount: '125.00' } });
    expect(work.wallet.version).toBe(2); expect(work.ledger).toHaveLength(1);
    expect([...work.rows.values()].find(tx => tx.kind === Kind.Win)!.referenceTransactionId).toBe('reference-id');
    expect(work.events.map(event => event.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });
  test.each([
    [{ walletId: 'other' }, FailureCode.ReferenceContextMismatch],
    [{ playerId: 'other' }, FailureCode.ReferenceContextMismatch],
    [{ currency: 'USD' }, FailureCode.ReferenceContextMismatch],
    [{ roundId: 'other' }, FailureCode.ReferenceContextMismatch],
    [{ kind: Kind.Win }, FailureCode.ReferenceKindInvalid],
    [{ status: Status.Rejected, failureCode: FailureCode.InsufficientFunds }, FailureCode.ReferenceRejected],
    [{ status: Status.Failed, failureCode: FailureCode.PermanentInfrastructureFailure }, FailureCode.ReferenceFailed],
  ] as const)('invalid reference %j is rejected by the domain with %s', async (overrides, failureCode) => {
    const work = new ReferenceWork(); fixture(work, overrides);
    expect(await processor(work).execute(input())).toMatchObject({ status: Status.Rejected, failureCode });
    expect(work.wallet.version).toBe(1); expect(work.ledger).toHaveLength(0);
    expect(work.events.map(event => event.eventType)).toEqual(['WagerTransactionRejected']);
  });
  test.each([Status.Pending, Status.PendingReference])('reference in %s produces pending acceptance', async status => {
    const work = new ReferenceWork(); fixture(work, { status, balance: null, balanceCurrency: null, completedAt: null,
      ...(status === Status.PendingReference ? { referenceExternalTransactionId: 'earlier', acceptedBalance: '100.00', acceptedCurrency: 'BRL' } : {}) });
    expect((await processor(work).execute(input())).status).toBe(Status.PendingReference);
    expect(work.ledger).toHaveLength(0);
  });
  test('self reference is a rejection rather than a technical pending fallback', async () => {
    const work = new ReferenceWork();
    expect(await processor(work).execute(input({ referenceExternalTransactionId: 'external' })))
      .toMatchObject({ status: Status.Rejected, failureCode: FailureCode.SelfReference });
  });
  test.each(['reference', 'result', 'outbox'])('technical failure in %s rolls back and propagates', async point => {
    const work = new ReferenceWork(); work.failAt = point;
    await expect(processor(work).execute(input())).rejects.toThrow('injected failure');
    expect(work.rows.size).toBe(0); expect(work.events).toHaveLength(0); expect(work.ledger).toHaveLength(0);
  });
  test.each(['payload', 'reference', 'external'])('pending identity conflict: %s', async change => {
    const work = new ReferenceWork(); const useCase = processor(work); await useCase.execute(input());
    const changed = change === 'payload' ? { money: { amount: '26.00', currency: 'BRL' } }
      : change === 'reference' ? { referenceExternalTransactionId: 'different' } : { idempotencyKey: 'different' };
    await expect(useCase.execute(input(changed))).rejects.toMatchObject({ code: 'WAGER_IDENTITY_CONFLICT' });
    expect(work.events).toHaveLength(1); expect(work.rows.size).toBe(1);
  });
  test('plain PENDING fixture still cannot masquerade as acceptance', async () => {
    const work = new ReferenceWork(); const tx = new WagerTransactionIdentity().createCandidate(input(), 'pending', at);
    work.rows.set(tx.id, tx);
    await expect(processor(work).execute(input())).rejects.toBeInstanceOf(WagerResultUnavailableError);
    expect(work.events).toHaveLength(0);
  });
  test.each([Kind.Bet, Kind.Loss, Kind.Refund, Kind.Rollback])('%s references remain unsupported before persistence', async kind => {
    const work = new ReferenceWork();
    await expect(processor(work).execute({ ...input(), kind })).rejects.toBeInstanceOf(WagerProcessingNotImplementedError);
    expect(work.calls).toHaveLength(0);
  });
});
