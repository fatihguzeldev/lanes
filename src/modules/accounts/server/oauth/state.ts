import { type OAuthPurpose } from '../../contracts/authorization';

export interface OAuthStartResult {
  authorizationUrl: string;
  cookie: string;
}
export interface OAuthFinishResult {
  redirectPath: string;
  cookies: string[];
  connectedAccountId?: string;
}

export interface OAuthStateRow {
  state_hash: string;
  browser_hash: string;
  purpose: OAuthPurpose;
  session_hash: string | null;
  account_id: string | null;
  verifier_ciphertext: string;
  nonce: string;
  return_path: string;
  planning_zone: string;
  expires_at: number;
  consumed_at: number;
  created_at: number;
}

export interface OAuthWriteAuthorization {
  sql: string;
  values: (string | number)[];
}
