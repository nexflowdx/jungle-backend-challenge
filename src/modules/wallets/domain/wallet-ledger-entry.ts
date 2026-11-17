import { DomainError } from '../../../shared/domain/domain-error';
import { assertIdentifier, assertVersion, timestamp } from '../../../shared/domain/financial-rules';
import { Money } from '../../../shared/domain/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;
}

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly #createdAt: number;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.walletVersion = state.walletVersion;
    this.#createdAt = timestamp(state.createdAt);
    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    for (const id of [props.id, props.walletId, props.transactionId]) assertIdentifier(id);
    assertVersion(props.walletVersion);
    if (!Object.values(LedgerDirection).includes(props.direction)) {
      throw new DomainError('INVALID_LEDGER_DIRECTION', 'Unknown ledger direction');
    }
    if (!props.money.isPositive() || props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new DomainError('INVALID_LEDGER_AMOUNT', 'Ledger requires a positive movement and non-negative balances');
    }
    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) throw new DomainError('UNBALANCED_LEDGER_ENTRY', 'Ledger arithmetic does not match');
    return entry;
  }

  // Trusted persisted snapshot: no movement is replayed or created.
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get createdAt(): Date { return new Date(this.#createdAt); }

  isBalanced(): boolean {
    const expected = this.direction === LedgerDirection.Debit
      ? this.balanceBefore.subtract(this.money)
      : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
