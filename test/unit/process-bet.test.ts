import { describe, expect, test } from 'bun:test';
import { walletMapper, transactionMapper } from '../../src/database/domain-mappers';
import type { IntegrationEvent } from '../../src/shared/domain/integration-event';
import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import type { WalletLedgerEntry } from '../../src/modules/wallets/domain/wallet-ledger-entry';
import type { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status, FailureCode } from '../../src/modules/wagering/domain/wager-transaction.types';
import { ProcessWagerTransaction, WagerProcessingNotImplementedError, WagerResultUnavailableError, type BetCommand, type ProcessingRuntime } from '../../src/modules/wagering/application/process-wager-transaction';
import { WagerIdentityCollisionError, WagerTransactionIdentity } from '../../src/modules/wagering/application/wager-transaction-identity';
import { WagerProcessingRetryableError, WagerProcessingUnitOfWork, type WagerProcessingTransaction } from '../../src/modules/wagering/application/wager-processing-unit-of-work';

const at = new Date('2026-11-17T12:00:00.000Z');
const cloneWallet = (wallet: Wallet) => walletMapper.toDomain(walletMapper.toRecord(wallet));
const cloneTx = (tx: WagerTransaction) => transactionMapper.toDomain(transactionMapper.toRecord(tx));
const command = (overrides: Partial<BetCommand> = {}): BetCommand => ({ walletId: 'wallet', playerId: 'player',
  providerId: 'provider', externalTransactionId: 'external', idempotencyKey: 'key', gameId: 'game', roundId: 'round',
  kind: Kind.Bet, money: { amount: '25.00', currency: 'BRL' }, correlationId: 'correlation', ...overrides });
function runtime(): ProcessingRuntime {
  let sequence = 0;
  return { newId: () => `id-${++sequence}`, now: () => at, retryDelay: async () => {} };
}

// Orchestration recorder using real domain rules. Database atomicity is tested separately with PostgreSQL.
class BetUnitOfWork extends WagerProcessingUnitOfWork {
  wallet: Wallet | undefined = Wallet.open({ id: 'wallet', playerId: 'player', at,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), opening: { id: 'opening', transactionId: 'opening-tx' } });
  rows = new Map<string, WagerTransaction>();
  ledger: WalletLedgerEntry[] = [];
  events: IntegrationEvent<unknown>[] = [];
  calls: string[] = [];
  retryFailures = 0;
  failAt: string | undefined;
  beforeCommit: () => Promise<void> = async () => {};
  readonly failure = new Error('Injected persistence failure');

  override async transaction<T>(work: (scope: WagerProcessingTransaction) => Promise<T>): Promise<T> {
    this.calls.push('begin');
    const wallet = this.wallet ? cloneWallet(this.wallet) : undefined;
    const rows = new Map([...this.rows].map(([id, tx]) => [id, cloneTx(tx)]));
    const ledger = [...this.ledger]; const events = [...this.events];
    const step = (name: string) => { this.calls.push(name); if (name === this.failAt) throw this.failure; };
    const result = await work({
      lockWallet: async () => { step('lock'); return wallet; },
      findIdentityCandidates: async key => { step('identity'); return [...rows.values()].filter(tx => tx.idempotencyKey === key.idempotencyKey
        || (tx.providerId === key.providerId && tx.externalTransactionId === key.externalTransactionId)); },
      insertPending: async tx => { step('pending'); rows.set(tx.id, cloneTx(tx)); },
      findReference: async () => { throw new Error('BET must not load references'); },
      findProcessedReversals: async () => { throw new Error('Existing operations must not query reversals'); },
      loadTransaction: async id => { step('load'); return rows.get(id); },
      saveWallet: async () => { step('wallet'); },
      completeTransaction: async tx => { step('result'); rows.set(tx.id, cloneTx(tx)); },
      insertLedgerEntry: async entry => { step('ledger'); ledger.push(entry); },
      insertEvents: async newEvents => { step('outbox'); events.push(...newEvents); },
    });
    await this.beforeCommit();
    if (this.retryFailures-- > 0) throw new WagerProcessingRetryableError('40P01', new Error('deadlock'));
    this.calls.push('commit');
    this.wallet = wallet; this.rows = rows; this.ledger = ledger; this.events = events;
    return result;
  }
}
const processor = (work: BetUnitOfWork) => new ProcessWagerTransaction(work, new WagerTransactionIdentity(), runtime());

describe('BET application orchestration (5.3)', () => {
  test('locks before identity and delegates the exact debit and events to the domain', async () => {
    const work = new BetUnitOfWork();
    const result = await processor(work).execute(command());
    expect(result).toMatchObject({ status: Status.Processed, balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });
    expect(work.calls).toEqual(['begin', 'lock', 'identity', 'pending', 'wallet', 'result', 'ledger', 'outbox', 'commit']);
    expect(work.wallet!.version).toBe(2);
    expect(work.ledger).toHaveLength(1);
    expect(work.ledger[0]!.isBalanced()).toBe(true);
    expect(work.events.map(event => event.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.balance)).toBe(true);
  });
  test('insufficient funds persist a real rejection and only its rejection event', async () => {
    const work = new BetUnitOfWork();
    const result = await processor(work).execute(command({ money: { amount: '100.01', currency: 'BRL' } }));
    expect(result).toMatchObject({ status: Status.Rejected, failureCode: FailureCode.InsufficientFunds, balance: { amount: '100.00' } });
    expect(work.wallet!.version).toBe(1);
    expect(work.ledger).toHaveLength(0);
    expect(work.calls).not.toContain('wallet');
    expect(work.events.map(event => event.eventType)).toEqual(['WagerTransactionRejected']);
  });
  test.each(['processed', 'rejected'])('a %s replay preserves its snapshot after another BET', async state => {
    const work = new BetUnitOfWork(); const useCase = processor(work);
    const input = command({ money: { amount: state === 'processed' ? '25.00' : '101.00', currency: 'BRL' } });
    const first = await useCase.execute(input);
    await useCase.execute(command({ idempotencyKey: 'second', externalTransactionId: 'second', money: { amount: '10.00', currency: 'BRL' } }));
    const count = work.events.length; const entries = work.ledger.length;
    const replayOnly: WagerProcessingUnitOfWork = { transaction: callback => work.transaction(scope => callback({ ...scope,
      lockWallet: async id => {
        const wallet = (await scope.lockWallet(id))!;
        return new Proxy(wallet, { get(target, key) {
          if (key === 'balance') throw new Error('Replay must not read the current wallet balance');
          return Reflect.get(target, key, target);
        } });
      },
    })) };
    expect(await new ProcessWagerTransaction(replayOnly).execute(input)).toEqual({ ...first, idempotentReplay: true });
    expect(work.events).toHaveLength(count); expect(work.ledger).toHaveLength(entries);
  });
  test('same key and changed payload conflict without a second effect', async () => {
    const work = new BetUnitOfWork(); const useCase = processor(work);
    await useCase.execute(command());
    await expect(useCase.execute(command({ money: { amount: '30.00', currency: 'BRL' } }))).rejects.toMatchObject({ code: 'WAGER_IDENTITY_CONFLICT' });
    expect(work.wallet!.balance.toString()).toBe('75.00'); expect(work.ledger).toHaveLength(1);
  });
  test('recovers a post-rollback identity collision and loads the stored financial snapshot', async () => {
    const work = new BetUnitOfWork(); const useCase = processor(work);
    const first = await useCase.execute(command());
    await useCase.execute(command({ idempotencyKey: 'second', externalTransactionId: 'second', money: { amount: '10.00', currency: 'BRL' } }));
    let collided = false;
    const collision: WagerProcessingUnitOfWork = { transaction: callback => {
      if (!collided) { collided = true; return Promise.reject(new WagerIdentityCollisionError('idempotency-key')); }
      return work.transaction(callback);
    } };
    expect(await new ProcessWagerTransaction(collision, new WagerTransactionIdentity(), runtime()).execute(command()))
      .toEqual({ ...first, idempotentReplay: true });
    expect(work.wallet!.balance.toString()).toBe('65.00');
    expect(work.ledger).toHaveLength(2); expect(work.events).toHaveLength(4);
  });
  test.each(['wallet', 'result', 'ledger', 'outbox'])('propagates a persistence error at %s without returning success', async point => {
    const work = new BetUnitOfWork(); work.failAt = point;
    await expect(processor(work).execute(command())).rejects.toBe(work.failure);
    expect(work.calls).not.toContain('commit');
  });
  test('does not turn a PENDING fixture into a financial success or execute it', async () => {
    const work = new BetUnitOfWork();
    const pending = new WagerTransactionIdentity().createCandidate(command(), 'pending-fixture', at);
    work.rows.set(pending.id, pending);
    await expect(processor(work).execute(command())).rejects.toBeInstanceOf(WagerResultUnavailableError);
    expect(work.wallet!.balance.toString()).toBe('100.00'); expect(work.ledger).toHaveLength(0);
  });
  test('a missing wallet fails before inserting an identity', async () => {
    const work = new BetUnitOfWork(); work.wallet = undefined;
    await expect(processor(work).execute(command())).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    expect(work.calls).toEqual(['begin', 'lock']);
  });
  test('BET references remain unavailable before persistence', async () => {
    const work = new BetUnitOfWork();
    await expect(processor(work).execute(command({ referenceExternalTransactionId: 'not-yet-supported' })))
      .rejects.toBeInstanceOf(WagerProcessingNotImplementedError);
    expect(work.calls).toHaveLength(0);
  });
  test('retries an entire deadlocked attempt with new domain objects and one final debit', async () => {
    const work = new BetUnitOfWork(); work.retryFailures = 1;
    expect((await processor(work).execute(command())).status).toBe(Status.Processed);
    expect(work.calls.filter(call => call === 'begin')).toHaveLength(2);
    expect(work.ledger).toHaveLength(1); expect(work.events).toHaveLength(2);
    expect(work.wallet!.balance.toString()).toBe('75.00');
  });
  test('limits deadlock retries to three complete attempts', async () => {
    const work = new BetUnitOfWork(); work.retryFailures = 3;
    await expect(processor(work).execute(command())).rejects.toBeInstanceOf(WagerProcessingRetryableError);
    expect(work.calls.filter(call => call === 'begin')).toHaveLength(3);
    expect(work.ledger).toHaveLength(0); expect(work.wallet!.balance.toString()).toBe('100.00');
  });
  test('only resolves the result after the commit boundary', async () => {
    const work = new BetUnitOfWork(); let release!: () => void; let reached!: () => void;
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    work.beforeCommit = async () => { reached(); await barrier; };
    let resolved = false;
    const running = processor(work).execute(command()).then(result => { resolved = true; return result; });
    await ready; expect(resolved).toBe(false); release(); await running; expect(resolved).toBe(true);
  });
});
