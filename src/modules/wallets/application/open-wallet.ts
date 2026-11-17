import { createHash, randomUUID } from 'node:crypto';
import { assertIdentifier } from '../../../shared/domain/financial-rules';
import { Money, type MoneyProps } from '../../../shared/domain/money';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { createTransactionEvents } from '../../wagering/domain/wagering.events';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction.types';
import { Wallet } from '../domain/wallet';
import { WalletOpeningUnitOfWork } from './wallet-opening-unit-of-work';

export interface OpenWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly correlationId: string;
  readonly causationId?: string;
}

export interface OpenWalletResult {
  readonly id: string;
  readonly playerId: string;
  readonly balance: Readonly<MoneyProps>;
  readonly version: number;
}

export interface OpeningRuntime {
  newId(): string;
  now(): Date;
}

export class OpenWallet {
  constructor(
    private readonly unitOfWork: WalletOpeningUnitOfWork,
    private readonly runtime: OpeningRuntime = { newId: randomUUID, now: () => new Date() },
  ) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    assertIdentifier(command.correlationId);
    if (command.causationId !== undefined) assertIdentifier(command.causationId);
    const initialBalance = Money.from(command.initialBalance);
    const at = this.runtime.now();
    const wallet = Wallet.open({
      id: this.runtime.newId(), playerId: command.playerId, initialBalance, at,
      ...(initialBalance.isPositive() ? {
        opening: { transactionId: this.runtime.newId(), id: this.runtime.newId() },
      } : {}),
    });
    const entry = wallet.pendingLedgerEntries[0];
    // The schema requires provider/game/round identity even for an internal operation.
    const openingData = {
      externalTransactionId: `opening:${wallet.id}`, gameId: 'wallet-opening',
      kind: WagerTransactionKind.Opening, money: initialBalance.toJSON(), playerId: wallet.playerId,
      providerId: 'internal:wallet-opening', roundId: `opening:${wallet.id}`, walletId: wallet.id,
    };
    const opening = entry ? WagerTransaction.createOpening({
      ...openingData, id: entry.transactionId, money: initialBalance,
      idempotencyKey: `opening:${wallet.id}`, createdAt: at,
      payloadHash: createHash('sha256').update(JSON.stringify(openingData)).digest('hex'),
    }) : undefined;
    opening?.markProcessed(undefined, wallet.balance, at);
    const events = opening ? createTransactionEvents(opening, wallet, entry, () => ({
      eventId: this.runtime.newId(), correlationId: command.correlationId,
      ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
      occurredAt: at,
    })) : [];

    await this.unitOfWork.transaction(async transaction => {
      await transaction.insertWallet(wallet);
      if (opening && entry) {
        await transaction.insertOpening(opening);
        await transaction.insertLedgerEntry(entry);
        await transaction.insertEvents(events);
      }
    });
    return Object.freeze({
      id: wallet.id, playerId: wallet.playerId,
      balance: Object.freeze(wallet.balance.toJSON()), version: wallet.version,
    });
  }
}
