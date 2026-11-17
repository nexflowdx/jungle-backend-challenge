import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction } from '../../src/modules/wagering/application/process-wager-transaction';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { PostgresWalletOpeningUnitOfWork } from '../../src/modules/wallets/infrastructure/postgres-wallet-opening-unit-of-work';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';
import { createHttpApplication } from '../../src/http/http-api.module';
import { httpRequest } from '../helpers/http-request';
import { withWagerFault } from '../helpers/wager-faults';
import { testPersistence, openTestWallet, wagerCommand, walletPersistenceSnapshot, assertWalletLedger } from '../helpers/postgres-wager-fixtures';

const enabled = process.env.PERSISTENCE_INTEGRATION === '1';
describe.skipIf(!enabled)('Processing atomicity gaps (5.9, real PostgreSQL)', () => {
  let orm: MikroORM;
  const work = () => new PostgresWagerProcessingUnitOfWork(orm);
  const processor = () => new ProcessWagerTransaction(work());
  beforeAll(async () => { orm = await testPersistence(); await orm.getMigrator().up(); }, 30000);
  afterAll(async () => { if (orm) await orm.close(true); });
  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])('%s rolls back even the first SQL outbox event and recovers with exactly one effect', async kind => {
    const target = await openTestWallet(orm);
    const reference = wagerCommand(target, kind === Kind.Rollback ? Kind.Win : Kind.Bet);
    if (kind === Kind.Refund || kind === Kind.Rollback) await processor().execute(reference);
    const input = wagerCommand(target, kind, kind === Kind.Refund || kind === Kind.Rollback ? { referenceExternalTransactionId: reference.externalTransactionId } : {});
    const before = await walletPersistenceSnapshot(orm, target);
    await expect(new ProcessWagerTransaction(withWagerFault(work(), 'first-event')).execute(input)).rejects.toThrow('Injected fault: first-event');
    expect(await walletPersistenceSnapshot(orm, target)).toEqual(before);
    const first = await processor().execute(input); expect(first).toMatchObject({ status: Status.Processed, idempotentReplay: false });
    const committed = await walletPersistenceSnapshot(orm, target);
    expect(committed.transactions).toHaveLength(before.transactions.length + 1);
    expect(committed.ledger).toHaveLength(before.ledger.length + 1); expect(committed.outbox).toHaveLength(before.outbox.length + 2);
    expect(await processor().execute(input)).toEqual({ ...first, idempotentReplay: true });
    expect(await walletPersistenceSnapshot(orm, target)).toEqual(committed);
    await assertWalletLedger(orm, target, kind === Kind.Bet ? '75.00' : kind === Kind.Win ? '125.00' : '100.00');
  });
  test.each(['first-event', 'before-commit'] as const)('HTTP fault at %s returns no success, rolls back and permits an idempotent retry', async point => {
    const target = await openTestWallet(orm); const input = wagerCommand(target); const { idempotencyKey, correlationId: _context, ...body } = input;
    const before = await walletPersistenceSnapshot(orm, target);
    const failing = await createHttpApplication({ walletOpening: new PostgresWalletOpeningUnitOfWork(orm), wagerProcessing: withWagerFault(work(), point) }, { logger: false });
    try {
      await failing.init(); expect((await httpRequest(failing, '/wagering/transactions', body, [['Idempotency-Key', idempotencyKey]])).status).toBe(500);
    } finally { await failing.close(); }
    expect(await walletPersistenceSnapshot(orm, target)).toEqual(before);
    const recovered = await createHttpApplication({ walletOpening: new PostgresWalletOpeningUnitOfWork(orm), wagerProcessing: work() }, { logger: false });
    try {
      await recovered.init(); const first = await httpRequest(recovered, '/wagering/transactions', body, [['Idempotency-Key', idempotencyKey]]);
      expect(first).toMatchObject({ status: 200, body: { idempotentReplay: false, balance: { amount: '75.00' } } });
      const committed = await walletPersistenceSnapshot(orm, target);
      expect(await httpRequest(recovered, '/wagering/transactions', body, [['Idempotency-Key', idempotencyKey]]))
        .toEqual({ status: 200, body: { ...first.body as object, idempotentReplay: true } });
      expect(await walletPersistenceSnapshot(orm, target)).toEqual(committed);
    } finally { await recovered.close(); }
    await assertWalletLedger(orm, target, '75.00');
  });
});
