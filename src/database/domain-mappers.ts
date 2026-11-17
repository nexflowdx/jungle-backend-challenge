import { Wallet } from '../modules/wallets/domain/wallet';
import { WalletLedgerEntry } from '../modules/wallets/domain/wallet-ledger-entry';
import { WagerTransaction } from '../modules/wagering/domain/wager-transaction';
import type { IntegrationEvent } from '../shared/domain/integration-event';
import { LedgerEntryRecord, OutboxMessageRecord, WagerTransactionRecord, WalletRecord } from './entities';
import { rehydrateMoney } from './money-mapping';

export const walletMapper = {
  toRecord(wallet: Wallet): WalletRecord {
    return Object.assign(new WalletRecord(), {
      id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
      balance: wallet.balance.toString(), version: wallet.version,
      createdAt: wallet.createdAt, updatedAt: wallet.updatedAt,
    });
  },
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({ ...record, balance: rehydrateMoney(record.balance, record.currency) });
  },
};

export const transactionMapper = {
  toRecord(tx: WagerTransaction): WagerTransactionRecord {
    return Object.assign(new WagerTransactionRecord(), {
      id: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey, payloadHash: tx.payloadHash,
      walletId: tx.walletId, playerId: tx.playerId, roundId: tx.roundId, gameId: tx.gameId,
      kind: tx.kind, amount: tx.money.toString(), currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null, status: tx.status,
      failureCode: tx.failureCode ?? null, acceptedBalance: tx.acceptedBalance?.toString() ?? null,
      acceptedCurrency: tx.acceptedBalance?.currency ?? null,
      balance: tx.isTerminal() ? tx.balance?.toString() ?? null : null,
      balanceCurrency: tx.isTerminal() ? tx.balance?.currency ?? null : null,
      createdAt: tx.createdAt, completedAt: tx.completedAt ?? null,
    });
  },
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id, providerId: record.providerId, externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey, payloadHash: record.payloadHash,
      walletId: record.walletId, playerId: record.playerId, roundId: record.roundId, gameId: record.gameId,
      kind: record.kind, status: record.status, createdAt: record.createdAt,
      money: rehydrateMoney(record.amount, record.currency),
      ...(record.referenceExternalTransactionId === null ? {} : { referenceExternalTransactionId: record.referenceExternalTransactionId }),
      ...(record.referenceTransactionId === null ? {} : { referenceTransactionId: record.referenceTransactionId }),
      ...(record.failureCode === null ? {} : { failureCode: record.failureCode }),
      ...(record.acceptedBalance === null ? {} : { acceptedBalance: rehydrateMoney(record.acceptedBalance, record.acceptedCurrency!) }),
      ...(record.balance === null ? {} : { balance: rehydrateMoney(record.balance, record.balanceCurrency!) }),
      ...(record.completedAt === null ? {} : { completedAt: record.completedAt }),
    });
  },
};

export const ledgerMapper = {
  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return Object.assign(new LedgerEntryRecord(), {
      id: entry.id, walletId: entry.walletId, transactionId: entry.transactionId,
      direction: entry.direction, amount: entry.money.toString(), currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toString(), balanceAfter: entry.balanceAfter.toString(),
      walletVersion: entry.walletVersion, createdAt: entry.createdAt,
    });
  },
  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({ ...record,
      money: rehydrateMoney(record.amount, record.currency),
      balanceBefore: rehydrateMoney(record.balanceBefore, record.currency),
      balanceAfter: rehydrateMoney(record.balanceAfter, record.currency),
    });
  },
};

export function outboxRecord(event: IntegrationEvent<unknown>): OutboxMessageRecord {
  return Object.assign(new OutboxMessageRecord(), {
    id: event.eventId, aggregateId: event.aggregateId, eventType: event.eventType,
    eventVersion: event.version, payload: event.toJSON(), occurredAt: event.occurredAt,
  });
}
