import { Injectable, type CanActivate } from '@nestjs/common';

/** Authentication is deliberately absent in 5.8, as allowed by README section 2.
 * Replace this guard with external IdP/OIDC token validation and provider claim binding.
 * This is an explicit extension point, not an implemented security boundary.
 */
@Injectable()
export class ProviderAuthenticationGuard implements CanActivate {
  canActivate(): boolean { return true; }
}
