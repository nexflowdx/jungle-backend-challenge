import { EntitySchema } from '@mikro-orm/core';
import type { Currency } from '../shared/domain/money';
import type { LedgerDirection } from '../modules/wallets/domain/wallet-ledger-entry';
import type { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../modules/wagering/domain/wager-transaction.types';
import { MoneyAmountType } from './money-mapping';

// Persistence records carry state only. Domain factories own financial behavior.
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: Currency;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  amount!: string;
  currency!: Currency;
  referenceExternalTransactionId: string | null = null;
  referenceTransactionId: string | null = null;
  status!: WagerTransactionStatus;
  failureCode: FailureCode | null = null;
  acceptedBalance: string | null = null;
  acceptedCurrency: Currency | null = null;
  balance: string | null = null;
  balanceCurrency: Currency | null = null;
  createdAt!: Date;
  completedAt: Date | null = null;
  referenceAttempts = 0;
  nextReferenceAttemptAt: Date | null = null;
  referenceDeadlineAt: Date | null = null;
}

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: LedgerDirection;
  amount!: string;
  currency!: Currency;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export class InboxMessageRecord {
  messageId!: string;
  consumerName!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt: Date | null = null;
}

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  eventVersion!: number;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts = 0;
  nextAttemptAt: Date | null = null;
  publishedAt: Date | null = null;
  leaseToken: string | null = null;
  leaseUntil: Date | null = null;
}

const text = { type: 'string', columnType: 'text' } as const;
const nullableText = { ...text, nullable: true } as const;
const amount = { type: MoneyAmountType, columnType: 'numeric' } as const;
const nullableAmount = { ...amount, nullable: true } as const;
const date = { type: Date, columnType: 'timestamptz' } as const;
const nullableDate = { ...date, nullable: true } as const;
const integer = { type: 'integer' } as const;

export const walletSchema = new EntitySchema({
  class: WalletRecord, tableName: 'wallets',
  properties: {
    id: { ...text, primary: true }, playerId: text, currency: text, balance: amount,
    // Explicit domain version; not an ORM version column (LOSS must not increment it).
    version: integer, createdAt: date, updatedAt: date,
  },
});

export const transactionSchema = new EntitySchema({
  class: WagerTransactionRecord, tableName: 'wager_transactions',
  properties: {
    id: { ...text, primary: true }, providerId: text, externalTransactionId: text,
    idempotencyKey: text, payloadHash: text,
    walletId: { kind: 'm:1', entity: () => WalletRecord, mapToPk: true, fieldName: 'wallet_id' }, playerId: text,
    roundId: text, gameId: text, kind: text, amount, currency: text,
    referenceExternalTransactionId: nullableText, referenceTransactionId: nullableText,
    status: text, failureCode: nullableText, acceptedBalance: nullableAmount,
    acceptedCurrency: nullableText, balance: nullableAmount, balanceCurrency: nullableText,
    createdAt: date, completedAt: nullableDate, referenceAttempts: integer,
    nextReferenceAttemptAt: nullableDate, referenceDeadlineAt: nullableDate,
  },
});

export const ledgerSchema = new EntitySchema({
  class: LedgerEntryRecord, tableName: 'wallet_ledger_entries',
  properties: {
    id: { ...text, primary: true },
    walletId: { kind: 'm:1', entity: () => WalletRecord, mapToPk: true, fieldName: 'wallet_id' },
    transactionId: { kind: 'm:1', entity: () => WagerTransactionRecord, mapToPk: true, fieldName: 'transaction_id' }, direction: text,
    amount, currency: text, balanceBefore: amount, balanceAfter: amount,
    walletVersion: integer, createdAt: date,
  },
});

export const inboxSchema = new EntitySchema({
  class: InboxMessageRecord, tableName: 'inbox_messages',
  properties: {
    messageId: { ...text, primary: true }, consumerName: { ...text, primary: true },
    payloadHash: text, receivedAt: date, processedAt: nullableDate,
  },
});

export const outboxSchema = new EntitySchema({
  class: OutboxMessageRecord, tableName: 'outbox_messages',
  properties: {
    id: { ...text, primary: true }, aggregateId: text, eventType: text, eventVersion: integer,
    payload: { type: 'json', columnType: 'jsonb' }, occurredAt: date,
    attempts: integer, nextAttemptAt: nullableDate, publishedAt: nullableDate,
    leaseToken: nullableText, leaseUntil: nullableDate,
  },
});

// Migrations are authoritative for CHECKs, FKs, partial indexes, privileges and triggers.
// SchemaGenerator must never be used to synchronize this financial schema.
export const persistenceEntities = [walletSchema, transactionSchema, ledgerSchema, inboxSchema, outboxSchema];
