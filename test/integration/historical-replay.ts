import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createPersistence } from '../../src/database/orm';
import { WalletRecord, WagerTransactionRecord, LedgerEntryRecord, OutboxMessageRecord } from '../../src/database/entities';
import { ProcessWagerTransaction, type SupportedWagerCommand, type ProcessWagerTransactionResult } from '../../src/modules/wagering/application/process-wager-transaction';
import type { WagerProcessingUnitOfWork } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { WageringModule } from '../../src/modules/wagering/wagering.module';
import { assertPersistenceTestEnvironment } from './environment';

async function snapshot(orm: MikroORM, walletId: string) {
  const manager = orm.em.fork();
  // Plain detached records preserve decimal strings, every field and every row, including outbox payloads.
  return structuredClone({
    wallet: { ...await manager.findOneOrFail(WalletRecord, walletId) },
    transactions: (await manager.find(WagerTransactionRecord, { walletId }, { orderBy: { id: 'asc' } })).map(row => ({ ...row })),
    ledger: (await manager.find(LedgerEntryRecord, { walletId }, { orderBy: { id: 'asc' } })).map(row => ({ ...row })),
    outbox: (await manager.find(OutboxMessageRecord, { aggregateId: walletId }, { orderBy: { id: 'asc' } })).map(row => ({ ...row })),
  });
}

/** Strengthens existing integration cases; no new cases or production behavior. */
export async function assertHistoricalReplay(orm: MikroORM, input: SupportedWagerCommand, original: ProcessWagerTransactionResult): Promise<void> {
  assertPersistenceTestEnvironment(process.env);
  const before = await snapshot(orm, input.walletId);
  expect(before.wallet.balance).not.toBe(original.balance.amount); // The later movement must make the snapshots distinguishable.
  const [previous] = await orm.em.fork().execute<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
  const restarted = await createPersistence({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test', user: 'diagnostic', password: process.env.PGPASSWORD! });
  try {
    const [current] = await restarted.em.fork().execute<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
    expect(current!.pid).not.toBe(previous!.pid);
    const forbidden = async (): Promise<never> => { throw new Error('Historical replay attempted processing or writes'); };
    const persistence = new PostgresWagerProcessingUnitOfWork(restarted);
    const readOnly: WagerProcessingUnitOfWork = { transaction: callback => persistence.transaction(scope => callback({ ...scope,
      lockWallet: async id => {
        const wallet = await scope.lockWallet(id);
        return wallet ? new Proxy(wallet, { get(target, key) {
          if (key === 'balance') throw new Error('Historical replay read the current wallet balance');
          return Reflect.get(target, key, target);
        } }) : undefined;
      },
      insertPending: forbidden, saveWallet: forbidden, completeTransaction: forbidden, insertLedgerEntry: forbidden,
      insertEvents: forbidden, findReference: forbidden, findProcessedReversals: forbidden,
    })) };
    const application = await NestFactory.createApplicationContext(WageringModule.register(readOnly), { logger: false, abortOnError: false });
    try {
      const useCase = application.get(ProcessWagerTransaction);
      expect(await useCase.execute({ ...input, correlationId: randomUUID() })).toEqual({ ...original, idempotentReplay: true });
      // Fingerprints and external identity must remain enforced in the new application too.
      await expect(useCase.execute({ ...input, money: { ...input.money, amount: input.money.amount === '0.01' ? '0.02' : '0.01' } }))
        .rejects.toMatchObject({ reason: 'PAYLOAD_MISMATCH' });
      await expect(useCase.execute({ ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ reason: 'EXTERNAL_ID_REUSED' });
    } finally { await application.close(); }
  } finally { await restarted.close(true); }
  expect(await snapshot(orm, input.walletId)).toEqual(before);
}
