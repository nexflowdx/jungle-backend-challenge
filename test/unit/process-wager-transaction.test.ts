import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { ProcessWagerTransaction, WagerProcessingNotImplementedError } from '../../src/modules/wagering/application/process-wager-transaction';
import { WagerProcessingUnitOfWork, type WagerProcessingTransaction } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { WagerTransactionKind as Kind } from '../../src/modules/wagering/domain/wager-transaction.types';
import { WageringModule } from '../../src/modules/wagering/wagering.module';

class UnreachableUnitOfWork extends WagerProcessingUnitOfWork {
  calls = 0;

  override async transaction<T>(_work: (scope: WagerProcessingTransaction) => Promise<T>): Promise<T> {
    this.calls++;
    throw new Error('Unavailable processing must not open a transaction');
  }
}

describe('ProcessWagerTransaction unavailable operations (5.1, no financial processing)', () => {
  test.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback, Kind.Opening])(
    'rejects %s before accessing persistence and never returns a financial result', async kind => {
      const work = new UnreachableUnitOfWork();
      const command = Object.freeze({ walletId: 'wallet', kind });
      const result: Promise<never> = new ProcessWagerTransaction(work).execute(command);
      await expect(result).rejects.toBeInstanceOf(WagerProcessingNotImplementedError);
      await expect(result).rejects.toMatchObject({ code: 'WAGER_PROCESSING_NOT_IMPLEMENTED', kind });
      expect(work.calls).toBe(0);
    },
  );

  test('remains unavailable when no wallet identifier is supplied at runtime', async () => {
    const work = new UnreachableUnitOfWork();
    await expect(new ProcessWagerTransaction(work).execute({ walletId: '', kind: Kind.Bet }))
      .rejects.toBeInstanceOf(WagerProcessingNotImplementedError);
    expect(work.calls).toBe(0);
  });

  test('resolves the Nest provider without starting a database connection', async () => {
    const work = new UnreachableUnitOfWork();
    const application = await NestFactory.createApplicationContext(WageringModule.register(work), { logger: false, abortOnError: false });
    try {
      await expect(application.get(ProcessWagerTransaction).execute({ walletId: 'wallet', kind: Kind.Bet }))
        .rejects.toBeInstanceOf(WagerProcessingNotImplementedError);
      expect(work.calls).toBe(0);
    } finally { await application.close(); }
  });
});
