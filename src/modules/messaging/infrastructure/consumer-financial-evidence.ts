import { AsyncLocalStorage } from 'node:async_hooks';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WagerProcessingUnitOfWork, type WagerProcessingTransaction } from '../../wagering/application/wager-processing-unit-of-work';
import type { WagerDeliveryFailure } from '../application/wager-delivery-policy';

interface Attempt { callbackFailed: boolean; rollbackConfirmed: boolean }
interface Observation { attempt?: Attempt; unsafe: boolean; lastRolledBack: boolean; started: boolean }
export class ConsumerProcessingFailure extends Error {
  constructor(readonly failure: WagerDeliveryFailure) { super('Consumer processing failed'); }
}
/** Observer only: no new SQL, retries, transaction boundaries or error translation. */
export class ConsumerFinancialEvidence extends WagerProcessingUnitOfWork {
  private readonly context = new AsyncLocalStorage<Observation>();
  constructor(orm: MikroORM, private readonly base: WagerProcessingUnitOfWork) {
    super();
    orm.em.getEventManager().registerSubscriber({ afterTransactionRollback: () => {
      const attempt = this.context.getStore()?.attempt;
      if (attempt) attempt.rollbackConfirmed = true;
    } });
  }
  override async transaction<T>(work: (scope: WagerProcessingTransaction) => Promise<T>): Promise<T> {
    const state = this.context.getStore();
    if (!state) return this.base.transaction(work);
    const attempt: Attempt = { callbackFailed: false, rollbackConfirmed: false };
    state.started = true; state.attempt = attempt; state.lastRolledBack = false;
    try {
      const result = await this.base.transaction(async scope => {
        try { return await work(scope); } catch (error) { attempt.callbackFailed = true; throw error; }
      });
      state.unsafe = true; // A later failure must never downgrade a prior successful commit.
      return result;
    } catch (error) {
      state.lastRolledBack = attempt.callbackFailed && attempt.rollbackConfirmed;
      if (!state.lastRolledBack) state.unsafe = true; // Includes all commit-phase uncertainty.
      throw error;
    }
  }
  observe<T>(work: () => Promise<T>): Promise<T> {
    return this.context.run({ unsafe: false, lastRolledBack: false, started: false }, async () => {
      try { return await work(); }
      catch (error) {
        const state = this.context.getStore()!;
        throw new ConsumerProcessingFailure({ phase: 'processing', error,
          financialOutcome: { kind: !state.started ? 'not-started'
            : !state.unsafe && state.lastRolledBack ? 'rolled-back' : 'uncertain' } });
      }
    });
  }
}
