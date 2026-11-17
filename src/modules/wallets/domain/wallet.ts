import { DomainError } from '../../../shared/domain/domain-error';
import { assertIdentifier, assertVersion, timestamp } from '../../../shared/domain/financial-rules';
import { Money, type Currency } from '../../../shared/domain/money';
import { CurrencyMismatchError } from '../../../shared/domain/money.errors';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: Currency;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LedgerIdentity {
  readonly id: string;
  readonly transactionId: string;
}

export interface WalletMovement extends LedgerIdentity {
  readonly money: Money;
  readonly at: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly at: Date;
  /** Supplied by the future atomic opening use case when the balance is positive. */
  readonly opening?: LedgerIdentity;
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: Currency;
  readonly #createdAt: number;
  #balance: Money;
  #version: number;
  #updatedAt: number;
  readonly #pendingLedgerEntries: WalletLedgerEntry[] = [];

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.currency;
    this.#balance = state.balance;
    this.#version = state.version;
    this.#createdAt = timestamp(state.createdAt);
    this.#updatedAt = timestamp(state.updatedAt);
    Object.freeze(this);
  }

  static open(props: OpenWalletProps): Wallet {
    assertIdentifier(props.id);
    assertIdentifier(props.playerId);
    if (props.initialBalance.isNegative()) {
      throw new DomainError('INVALID_WALLET_BALANCE', 'Opening balance cannot be negative');
    }
    const wallet = new Wallet({
      id: props.id, playerId: props.playerId, currency: props.initialBalance.currency,
      balance: props.initialBalance, version: 1, createdAt: props.at, updatedAt: props.at,
    });
    if (props.initialBalance.isPositive()) {
      if (!props.opening) {
        throw new DomainError('OPENING_LEDGER_REQUIRED', 'Positive opening requires transaction and ledger identities');
      }
      wallet.#pendingLedgerEntries.push(WalletLedgerEntry.create({
        ...props.opening, walletId: wallet.id, direction: LedgerDirection.Credit,
        money: props.initialBalance, balanceBefore: Money.zero(wallet.currency),
        balanceAfter: wallet.balance, walletVersion: 1, createdAt: props.at,
      }));
    }
    return wallet;
  }

  static rehydrate(state: WalletState): Wallet {
    // Validate snapshot shape/invariants, without applying opening or replaying ledger.
    assertVersion(state.version);
    if (state.balance.isNegative()) throw new DomainError('INVALID_WALLET_BALANCE', 'Balance cannot be negative');
    if (state.currency !== state.balance.currency) throw new CurrencyMismatchError();
    return new Wallet(state);
  }

  get balance(): Money { return this.#balance; }
  get version(): number { return this.#version; }
  get createdAt(): Date { return new Date(this.#createdAt); }
  get updatedAt(): Date { return new Date(this.#updatedAt); }
  /** Only entries produced by this instance, never a loaded history or deduplication cache. */
  get pendingLedgerEntries(): readonly WalletLedgerEntry[] { return Object.freeze([...this.#pendingLedgerEntries]); }

  debit(props: WalletMovement): WalletLedgerEntry { return this.move(LedgerDirection.Debit, props); }
  credit(props: WalletMovement): WalletLedgerEntry { return this.move(LedgerDirection.Credit, props); }

  private move(direction: LedgerDirection, props: WalletMovement): WalletLedgerEntry {
    if (this.#pendingLedgerEntries.some((entry) => entry.id === props.id || entry.transactionId === props.transactionId)) {
      throw new DomainError('DUPLICATE_LEDGER_ENTRY', 'A movement identity cannot be reused within the aggregate');
    }
    if (props.money.currency !== this.currency) throw new CurrencyMismatchError();
    if (!props.money.isPositive()) throw new DomainError('INVALID_MOVEMENT_AMOUNT', 'Movement must be positive');
    if (direction === LedgerDirection.Debit && this.balance.isLessThan(props.money)) {
      throw new DomainError('INSUFFICIENT_FUNDS', 'Wallet has insufficient funds');
    }
    const version = this.version + 1;
    assertVersion(version);
    const balanceAfter = direction === LedgerDirection.Debit
      ? this.balance.subtract(props.money) : this.balance.add(props.money);
    const entry = WalletLedgerEntry.create({
      id: props.id, transactionId: props.transactionId, walletId: this.id, direction,
      money: props.money, balanceBefore: this.balance, balanceAfter,
      walletVersion: version, createdAt: props.at,
    });
    // All fallible work happens before changing the aggregate.
    this.#balance = balanceAfter;
    this.#version = version;
    this.#updatedAt = timestamp(props.at);
    this.#pendingLedgerEntries.push(entry);
    return entry;
  }
}
