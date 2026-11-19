import { expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ConsumerFinancialEvidence } from '../../src/modules/messaging/infrastructure/consumer-financial-evidence';
import type { WagerProcessingTransaction, WagerProcessingUnitOfWork } from '../../src/modules/wagering/application/wager-processing-unit-of-work';

function fixture(commitFails = false, rollbackConfirmed = true) {
  let rolledBack: (() => void) | undefined;
  const orm = { em: { getEventManager: () => ({ registerSubscriber: (subscriber: { afterTransactionRollback: () => void }) => { rolledBack = subscriber.afterTransactionRollback; } }) } } as unknown as MikroORM;
  const base: WagerProcessingUnitOfWork = { transaction: async work => {
    let result;
    try { result = await work({} as WagerProcessingTransaction); }
    catch (error) { if (rollbackConfirmed) rolledBack?.(); throw error; }
    if (commitFails) { rolledBack?.(); throw new Error('commit ambiguous'); }
    return result;
  } };
  return new ConsumerFinancialEvidence(orm, base);
}
test('callback failure plus confirmed rollback is evidence independent of exception class', async () => {
  const evidence = fixture(); const original = new Error('original');
  await expect(evidence.observe(() => evidence.transaction(async () => { throw original; })))
    .rejects.toMatchObject({ failure: { phase: 'processing', error: original, financialOutcome: { kind: 'rolled-back' } } });
});
test('missing rollback confirmation and commit failures remain uncertain even after rollback hook', async () => {
  const absent = fixture(false, false);
  await expect(absent.observe(() => absent.transaction(async () => { throw new Error(); }))).rejects.toMatchObject({ failure: { financialOutcome: { kind: 'uncertain' } } });
  const ambiguous = fixture(true);
  await expect(ambiguous.observe(() => ambiguous.transaction(async () => 'callback result'))).rejects.toMatchObject({ failure: { financialOutcome: { kind: 'uncertain' } } });
});
test('prior successful commit cannot be downgraded by a later confirmed rollback', async () => {
  const evidence = fixture();
  await expect(evidence.observe(async () => { await evidence.transaction(async () => 'committed'); await evidence.transaction(async () => { throw new Error(); }); }))
    .rejects.toMatchObject({ failure: { financialOutcome: { kind: 'uncertain' } } });
});
test('before-transaction failure is not-started and concurrent observations cannot leak evidence', async () => {
  const evidence = fixture();
  const results = await Promise.allSettled([
    evidence.observe(() => evidence.transaction(async () => { await Promise.resolve(); throw new Error('sql'); })),
    evidence.observe(async () => { await Promise.resolve(); throw new Error('validation'); }),
  ]);
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { failure: { financialOutcome: { kind: 'rolled-back' } } } });
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { failure: { financialOutcome: { kind: 'not-started' } } } });
});
