import type { ConnectionSummary } from '../../modules/accounts/contracts';

/** Created only after the owner session and account connection have been checked. */
export interface AccountRouteContext {
  request: Request;
  url: URL;
  route: string[];
  account: ConnectionSummary;
  ownerSubject: string;
}
