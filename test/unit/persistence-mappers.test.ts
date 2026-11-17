import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { ledgerMapper, transactionMapper, walletMapper, outboxRecord } from '../../src/database/domain-mappers';
import { databaseOptions } from '../../src/database/orm';
import { MoneyAmountType } from '../../src/database/money-mapping';
import { LedgerEntryRecord, WagerTransactionRecord } from '../../src/database/entities';
import { runtimePrivilegesSql } from '../../src/database/runtime-privileges';
import { WalletBalanceChanged } from '../../src/modules/wallets/domain/wallet-balance-changed';
import { FailureCode, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/modules/wagering/domain/wager-transaction.types';
import { later, money, process, transaction, wallet } from './financial-fixtures';

describe('persistence adapters (3.2–3.5)', () => {
  test('rehydrates a large wallet and ledger without replaying opening or changing version', () => {
    const original = wallet('9007199254740993.01', 'USD');
    const restored = walletMapper.toDomain(walletMapper.toRecord(original));
    expect(restored.balance.equals(original.balance)).toBe(true);
    expect(restored.version).toBe(1);
    expect(restored.pendingLedgerEntries).toHaveLength(0);
    const entry = original.pendingLedgerEntries[0]!;
    const restoredEntry = ledgerMapper.toDomain(ledgerMapper.toRecord(entry));
    expect(restoredEntry.money.equals(entry.money)).toBe(true);
    expect(restoredEntry.isBalanced()).toBe(true);
    expect(restoredEntry.walletVersion).toBe(1);
  });
  test('pending records retain absent snapshots as null, never as an invented balance', () => {
    const record = transactionMapper.toRecord(transaction());
    expect(record.balance).toBeNull();
    expect(record.acceptedBalance).toBeNull();
    const restored = transactionMapper.toDomain(record);
    expect(restored.balance).toBeUndefined();
    expect(restored.referenceTransactionId).toBeUndefined();
    expect(restored.failureCode).toBeUndefined();
    expect(restored.completedAt).toBeUndefined();
  });
  test('preserves the pending acceptance snapshot across rehydration', () => {
    const tx = transaction({ kind: Kind.Refund, referenceExternalTransactionId: 'missing' });
    tx.markPendingReference(money('90.00'));
    const record = transactionMapper.toRecord(tx);
    expect(record.balance).toBeNull();
    const restored = transactionMapper.toDomain(record);
    restored.markPendingReference(money('200.00'));
    expect(restored.balance?.toString()).toBe('90.00');
    expect(restored.referenceExternalTransactionId).toBe('missing');
  });
  test('preserves terminal historical balance and state without repeating the debit', () => {
    const target = wallet();
    const tx = transaction();
    process(tx, target);
    const restored = transactionMapper.toDomain(transactionMapper.toRecord(tx));
    expect(restored.balance?.toString()).toBe('90.00');
    expect(restored.completedAt).toEqual(later);
    expect(() => process(restored, target)).toThrow();
    expect(target.balance.toString()).toBe('90.00');
  });
  test('keeps rejected operation currency distinct from the observed wallet currency', () => {
    const tx = transaction({ money: money('10.00', 'USD') });
    process(tx, wallet());
    const restored = transactionMapper.toDomain(transactionMapper.toRecord(tx));
    expect(restored.money.currency).toBe('USD');
    expect(restored.balance?.currency).toBe('BRL');
    expect(restored.failureCode).toBe(FailureCode.CurrencyMismatch);
  });
  test('maps the stable event envelope for future outbox publication', () => {
    const target = wallet();
    const tx = transaction();
    const entry = process(tx, target)!;
    const event = WalletBalanceChanged.from(target, entry, {
      eventId: 'event', correlationId: 'correlation', occurredAt: later,
    });
    const record = outboxRecord(event);
    expect(record.id).toBe(event.eventId);
    expect(record.payload).toEqual({ ...event.toJSON() });
    expect(record.attempts).toBe(0);
    expect(record.publishedAt).toBeNull();
    expect(record.leaseToken).toBeNull();
  });
  describe('ORM metadata, SQL and snapshots without a database connection', () => {
    let orm: MikroORM;
    beforeAll(async () => {
      orm = await MikroORM.init({ ...databaseOptions({
        host: 'unused', port: 5432, dbName: 'unused', user: 'unused', password: 'unused',
      }), connect: false });
    });
    afterAll(async () => { if (orm) await orm.close(true); });

    test('discovers exact numeric types and scalar foreign keys with migration column names', () => {
      const metadata = Object.values(orm.getMetadata().getAll());
      expect(metadata).toHaveLength(5);
      const monetary = metadata.flatMap(entity => entity.props).filter(prop => prop.customType instanceof MoneyAmountType);
      expect(monetary).toHaveLength(7);
      for (const property of monetary) expect(property.columnTypes).toEqual(['numeric']);
      // Scalar foreign keys still describe dependencies to the Unit of Work.
      const transactionWallet = orm.getMetadata().get(WagerTransactionRecord).properties.walletId;
      const ledgerWallet = orm.getMetadata().get(LedgerEntryRecord).properties.walletId;
      const ledgerTransaction = orm.getMetadata().get(LedgerEntryRecord).properties.transactionId;
      for (const [property, column, target] of [
        [transactionWallet, 'wallet_id', 'WalletRecord'],
        [ledgerWallet, 'wallet_id', 'WalletRecord'],
        [ledgerTransaction, 'transaction_id', 'WagerTransactionRecord'],
      ] as const) {
        expect(property.mapToPk).toBe(true);
        expect(property.targetMeta?.className).toBe(target);
        expect(property.fieldNames).toEqual([column]);
        expect(property.joinColumns).toEqual([column]);
      }
      expect(orm.em.fork()).not.toBe(orm.em.fork());
    });

    test.each([WagerTransactionRecord, LedgerEntryRecord])('generates SELECT, INSERT and UPDATE using migration foreign keys for %s', entity => {
      const em = orm.em.fork();
      const relations = entity === LedgerEntryRecord
        ? { walletId: 'wallet', transactionId: 'transaction' } : { walletId: 'wallet' };
      const columns = entity === LedgerEntryRecord ? ['wallet_id', 'transaction_id'] : ['wallet_id'];
      const record = entity === LedgerEntryRecord
        ? ledgerMapper.toRecord(wallet().pendingLedgerEntries[0]!) : transactionMapper.toRecord(transaction());
      const queries = [
        em.createQueryBuilder(entity.name).select('*').where(relations),
        em.createQueryBuilder(entity.name).insert({ ...record, ...relations }),
        em.createQueryBuilder(entity.name).update(relations).where({ id: record.id }),
      ];
      for (const query of queries) {
        const sql = query.getQuery();
        for (const column of columns) expect(sql).toContain(`"${column}"`);
        expect(sql).not.toMatch(/(?:wallet|transaction)_id_id/);
        expect(query.getParams()).toContain('wallet');
        if (entity === LedgerEntryRecord) expect(query.getParams()).toContain('transaction');
      }
    });

    test.each([Status.Pending, Status.PendingReference, Status.Processed, Status.Rejected])('prepares %s ORM snapshots without inventing nullable amounts', status => {
      const tx = transaction({ kind: Kind.Win, referenceExternalTransactionId: 'reference' });
      if (status === Status.PendingReference) tx.markPendingReference(money('100.00'));
      if (status === Status.Processed) tx.markProcessed('reference-id', money('110.00'), later);
      if (status === Status.Rejected) tx.reject(FailureCode.ReferenceNotFound, money('100.00'), later);
      const record = transactionMapper.toRecord(tx);
      const snapshot = orm.em.fork().getComparator().prepareEntity(record);
      expect(snapshot.walletId).toBe(record.walletId);
      expect(snapshot.amount).toBe('10.00');
      expect(snapshot.acceptedBalance).toBe(status === Status.PendingReference ? '100.00' : null);
      expect(snapshot.balance).toBe(status === Status.Processed ? '110.00' : status === Status.Rejected ? '100.00' : null);
      expect(snapshot).not.toHaveProperty('walletIdId');
    });
  });
  test('rejects unsafe privilege identifiers', () => {
    expect(() => runtimePrivilegesSql('x; DROP TABLE wallets')).toThrow();
    expect(runtimePrivilegesSql('wager_runtime')).toContain('GRANT SELECT, INSERT');
  });
});
