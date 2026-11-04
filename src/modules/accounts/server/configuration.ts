import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import type { TokenKey } from './credentials/crypto';
import type {
  GoogleOAuthConfig,
  GoogleFetch,
  exchangeGoogleCode,
  verifyGoogleIdToken,
} from './oauth/google';

export interface AccountConfig {
  origin: string;
  ownerEmail: string;
  sessionKey: string;
  tokenKey: TokenKey;
  google: GoogleOAuthConfig;
}

export interface AccountDependencies {
  now?: () => number;
  exchange?: typeof exchangeGoogleCode;
  verify?: typeof verifyGoogleIdToken;
  fetch?: GoogleFetch;
  /** Preferences can join a composition-owned operation receipt transaction. */
  commitPreferences?(writes: D1PreparedStatement[]): Promise<D1Result[]>;
}
