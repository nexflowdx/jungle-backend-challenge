import type { LedgerDirection } from '../domain/wallet-ledger-entry';
import type { MoneyProps } from '../../../shared/domain/money';

export interface LedgerHistoryItem {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
  /** Exact UTC PostgreSQL timestamp, including all six fractional digits. */
  readonly createdAt: string;
}
export interface LedgerPosition { readonly createdAt: string; readonly id: string }
export abstract class WalletLedgerReader {
  /** undefined means wallet not found; [] means an existing wallet without entries. */
  abstract read(walletId: string, limit: number, before?: LedgerPosition): Promise<readonly LedgerHistoryItem[] | undefined>;
}
export class InvalidLedgerQueryError extends Error {}
export class LedgerWalletNotFoundError extends Error {}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) return false;
  // Validate calendar fields without ever round-tripping the timestamp through Date.
  const year = Number(value.slice(0, 4)); const month = Number(value.slice(5, 7)); const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60;
}
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !value.includes('\u0000');
function decodeCursor(cursor: unknown, walletId: string): LedgerPosition {
  try {
    if (typeof cursor !== 'string' || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error();
    const data: unknown = JSON.parse(decoded.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    const row = data as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'createdAt,id,v,walletId' || row.v !== 1 || row.walletId !== walletId
      || !identifier(row.id) || !validTimestamp(row.createdAt)) throw new Error();
    return { id: row.id, createdAt: row.createdAt };
  } catch { throw new InvalidLedgerQueryError(); }
}
export class ReadWalletLedger {
  constructor(private readonly reader: WalletLedgerReader) {}

  async execute(walletId: string, query: { readonly limit?: unknown; readonly cursor?: unknown } = {}) {
    if (!identifier(walletId)) throw new InvalidLedgerQueryError();
    const limit = query.limit === undefined ? 50 : typeof query.limit === 'string' && /^[1-9]\d{0,2}$/.test(query.limit) ? Number(query.limit) : NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new InvalidLedgerQueryError();
    const before = query.cursor === undefined ? undefined : decodeCursor(query.cursor, walletId);
    const rows = await this.reader.read(walletId, limit + 1, before);
    if (rows === undefined) throw new LedgerWalletNotFoundError();
    const hasNextPage = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = hasNextPage && last ? Buffer.from(JSON.stringify({ v: 1, walletId, createdAt: last.createdAt, id: last.id })).toString('base64url') : null;
    return { items, hasNextPage, nextCursor };
  }
}
