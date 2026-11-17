import { Money } from '../../src/shared/domain/money';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import {
  type CreateWagerTransactionProps, WagerTransactionKind as Kind, WagerTransactionStatus as Status,
} from '../../src/modules/wagering/domain/wager-transaction.types';

export const at = new Date('2026-11-17T12:00:00.000Z');
export const later = new Date('2026-11-17T12:01:00.000Z');
export const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });
let sequence = 0;

export function wallet(amount = '100.00', currency = 'BRL'): Wallet {
  return Wallet.open({
    id: 'wallet', playerId: 'player', initialBalance: money(amount, currency), at,
    opening: { id: 'opening-entry', transactionId: 'opening-transaction' },
  });
}

export function transactionProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  const id = `transaction-${++sequence}`;
  return {
    id, providerId: 'provider', externalTransactionId: `external-${id}`, idempotencyKey: `key-${id}`,
    payloadHash: `hash-${id}`, walletId: 'wallet', playerId: 'player', roundId: 'round', gameId: 'game',
    kind: Kind.Bet, money: money('10.00'), createdAt: at, ...overrides,
  };
}

export function transaction(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create(transactionProps(overrides));
}

export function reference(kind = Kind.Bet, overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.rehydrate({
    ...transactionProps({ kind, ...overrides }), status: Status.Processed, balance: money('90.00'), completedAt: at,
  });
}

export function process(tx: WagerTransaction, target: Wallet, ref?: WagerTransaction, priorReversals: readonly WagerTransaction[] = []) {
  return tx.process(target, {
    at: later, ledgerEntryId: `entry-${tx.id}`, priorReversals, ...(ref === undefined ? {} : { reference: ref }),
  });
}
