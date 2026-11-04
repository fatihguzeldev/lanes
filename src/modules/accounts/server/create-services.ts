import type { D1Database } from '@cloudflare/workers-types';
import type { AccountConfig, AccountDependencies } from './configuration';
import { OwnerSessions } from './session/sessions';
import { GoogleAuthorization } from './oauth/authorization';
import { AccountConnections } from './connections/accounts';

/** Accounts composes session authority, Google authorization and connected-account data. */
export function createAccountServices(
  db: D1Database,
  config: AccountConfig,
  dependencies: AccountDependencies = {},
) {
  const sessions = new OwnerSessions(db, config, dependencies);
  return {
    sessions,
    oauth: new GoogleAuthorization(db, config, sessions, dependencies),
    connections: new AccountConnections(db, config, sessions, dependencies),
  };
}
export type AccountServices = ReturnType<typeof createAccountServices>;
