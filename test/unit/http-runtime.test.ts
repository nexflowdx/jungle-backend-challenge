import 'reflect-metadata';
import { expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseOptions } from '../../src/database/orm';
import { createHttpApplication } from '../../src/http/http-api.module';
import { httpDatabaseConnection } from '../../src/http/runtime-persistence';
import { PostgresWalletOpeningUnitOfWork } from '../../src/modules/wallets/infrastructure/postgres-wallet-opening-unit-of-work';
import { PostgresWagerProcessingUnitOfWork } from '../../src/modules/wagering/infrastructure/postgres-wager-processing-unit-of-work';
import { OpenWallet } from '../../src/modules/wallets/application/open-wallet';
import { ProcessWagerTransaction } from '../../src/modules/wagering/application/process-wager-transaction';
import { WalletOpeningUnitOfWork } from '../../src/modules/wallets/application/wallet-opening-unit-of-work';
import { WagerProcessingUnitOfWork } from '../../src/modules/wagering/application/wager-processing-unit-of-work';
import { httpRequest } from '../helpers/http-request';

const env = { PGHOST: 'localhost', PGPORT: '5432', PGDATABASE: 'unit_metadata_only', PGUSER: 'unit', PGPASSWORD: 'unit' };
test('HTTP configuration requires explicit database settings', () => {
  expect(httpDatabaseConnection(env)).toEqual({ host: 'localhost', port: 5432, dbName: 'unit_metadata_only', user: 'unit', password: 'unit' });
});
test.each(['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'])('missing %s fails before connecting', key => {
  expect(() => httpDatabaseConnection({ ...env, [key]: '' })).toThrow();
});
test.each(['0', '65536', '1.5', 'NaN', ' 5432', '5432 '])('invalid port %s fails before connecting', PGPORT => {
  expect(() => httpDatabaseConnection({ ...env, PGPORT })).toThrow();
});
test('Nest initializes controllers and real providers with ORM metadata, without connecting to PostgreSQL', async () => {
  const orm = await MikroORM.init({ ...databaseOptions(httpDatabaseConnection(env)), connect: false });
  const opening = new PostgresWalletOpeningUnitOfWork(orm); const wagering = new PostgresWagerProcessingUnitOfWork(orm);
  let application: Awaited<ReturnType<typeof createHttpApplication>> | undefined;
  try {
    application = await createHttpApplication({ walletOpening: opening, wagerProcessing: wagering }, { logger: false }); await application.init();
    expect(application.get(OpenWallet)).toBeInstanceOf(OpenWallet);
    expect(application.get(ProcessWagerTransaction)).toBeInstanceOf(ProcessWagerTransaction);
    expect(application.get(WalletOpeningUnitOfWork)).toBe(opening); expect(application.get(WagerProcessingUnitOfWork)).toBe(wagering);
    // Invalid DTOs never attempt a connection, even with the real adapters wired.
    expect((await httpRequest(application, '/wallets', { playerId: 'player', initialBalance: { amount: 1, currency: 'BRL' } })).status).toBe(400);
    expect((await httpRequest(application, '/wagering/transactions', {})).status).toBe(400);
  } finally { if (application) await application.close(); await orm.close(true); }
});
