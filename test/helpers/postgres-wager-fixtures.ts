import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createPersistence } from '../../src/database/orm';
import { WalletRecord, WagerTransactionRecord, LedgerEntryRecord, OutboxMessageRecord } from '../../src/database/entities';
import { ledgerMapper } from '../../src/database/domain-mappers';
import { rehydrateMoney } from '../../src/database/money-mapping';
import { OpenWallet } from '../../src/modules/wallets/application/open-wallet';
import { PostgresWalletOpeningUnitOfWork } from '../../src/modules/wallets/infrastructure/postgres-wallet-opening-unit-of-work';
import type { SupportedWagerCommand } from '../../src/modules/wagering/application/process-wager-transaction';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';
import { assertPersistenceTestEnvironment } from '../integration/environment';

export type TestWallet = { id: string; playerId: string; balance: { amount: string; currency: string } };
export function testPersistence() {
  assertPersistenceTestEnvironment(process.env);
  return createPersistence({ host: 'postgres', port: 5432, dbName: 'jungle_persistence_test', user: 'diagnostic', password: process.env.PGPASSWORD! });
}
export function openTestWallet(orm: MikroORM, amount = '100.00', currency = 'BRL') {
  return new OpenWallet(new PostgresWalletOpeningUnitOfWork(orm)).execute({ playerId: randomUUID(), initialBalance: { amount, currency }, correlationId: randomUUID() });
}
export function wagerCommand(wallet: TestWallet, kind: SupportedWagerCommand['kind'] = Kind.Bet, overrides: Partial<SupportedWagerCommand> = {}): SupportedWagerCommand {
  return { walletId: wallet.id, playerId: wallet.playerId, kind, providerId: 'provider', externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(), roundId: 'round', gameId: 'game', money: { amount: '25.00', currency: wallet.balance.currency }, correlationId: randomUUID(), ...overrides };
}
export async function walletPersistenceSnapshot(orm: MikroORM, wallet: TestWallet) {
  const manager = orm.em.fork();
  return structuredClone({
    wallet: { ...await manager.findOneOrFail(WalletRecord, wallet.id) },
    transactions: (await manager.find(WagerTransactionRecord, { walletId: wallet.id }, { orderBy: { id: 'asc' } })).map(row => ({ ...row })),
    ledger: (await manager.find(LedgerEntryRecord, { walletId: wallet.id }, { orderBy: { id: 'asc' } })).map(row => ({ ...row })),
    outbox: (await manager.find(OutboxMessageRecord, { aggregateId: wallet.id }, { orderBy: { id: 'asc' } })).map(row => ({ ...row })),
  });
}
export async function assertWalletLedger(orm: MikroORM, wallet: TestWallet, expected: string) {
  const [row] = await orm.em.fork().execute<{ balance: string; reconstructed: string; version: number; last_version: number }[]>(`SELECT w.balance,w.version,
    COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END),0) AS reconstructed,
    COALESCE(MAX(e.wallet_version),1) AS last_version FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id=w.id WHERE w.id=? GROUP BY w.id`, [wallet.id]);
  expect(row!.balance).toBe(expected);
  expect(rehydrateMoney(row!.balance, wallet.balance.currency).equals(rehydrateMoney(row!.reconstructed, wallet.balance.currency))).toBe(true);
  expect(row!.version).toBe(row!.last_version);
  const snapshot = await walletPersistenceSnapshot(orm, wallet);
  for (const tx of snapshot.transactions) {
    const entries = snapshot.ledger.filter(entry => entry.transactionId === tx.id);
    const events = snapshot.outbox.filter(event => (event.payload.data as { transactionId: string }).transactionId === tx.id);
    const movement = tx.status === Status.Processed && tx.kind !== Kind.Loss;
    expect(entries).toHaveLength(movement ? 1 : 0);
    if (entries[0]) {
      expect(entries[0]).toMatchObject({ amount: tx.amount, balanceAfter: tx.balance });
      expect(ledgerMapper.toDomain(entries[0]).isBalanced()).toBe(true);
    }
    const types = tx.status === Status.PendingReference ? ['WagerTransactionPendingReference']
      : tx.status === Status.Rejected ? ['WagerTransactionRejected'] : movement ? ['WagerTransactionProcessed', 'WalletBalanceChanged'] : ['WagerTransactionProcessed'];
    expect(events.map(event => event.eventType).sort()).toEqual(types.sort());
    for (const event of events) expect(event.publishedAt).toBeNull();
  }
}
