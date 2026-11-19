import { ForbiddenException, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';

/** Shared financial read policy for ledger history and reconciliation.
 * Trusted server-side integration must validate identity and wallet ownership.
 * Never derive permission from a client-supplied wallet/provider/player header alone.
 */
export abstract class WalletLedgerAccess {
  abstract canRead(request: IncomingMessage, walletId: string): boolean | Promise<boolean>;
}
export const deniedWalletLedgerAccess: WalletLedgerAccess = { canRead: () => false };

@Injectable()
export class WalletLedgerAccessGuard implements CanActivate {
  constructor(@Inject(WalletLedgerAccess) private readonly access: WalletLedgerAccess) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IncomingMessage & { params: { walletId: string } }>();
    if (!await this.access.canRead(request, request.params.walletId)) throw new ForbiddenException();
    return true;
  }
}
