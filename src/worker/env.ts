import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../contracts/errors';
import { validateTokenKey } from '../modules/accounts/crypto';
import type { TokenKey } from '../modules/accounts/crypto';
import type { GoogleOAuthConfig } from '../modules/accounts/google';

export interface Env {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  APP_ORIGIN?: string;
  OWNER_EMAIL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_KEY?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  TOKEN_KEY_ID?: string;
}

export interface Configuration {
  origin: string;
  ownerEmail: string;
  sessionKey: string;
  tokenKey: TokenKey;
  google: GoogleOAuthConfig;
}

const inputSchema = z.object({
  APP_ORIGIN: z.string().url(),
  OWNER_EMAIL: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase()),
  GOOGLE_CLIENT_ID: z.string().trim().min(1).max(512),
  GOOGLE_CLIENT_SECRET: z.string().min(1).max(2048),
  SESSION_KEY: z.string(),
  TOKEN_ENCRYPTION_KEY: z.string(),
  TOKEN_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .default('v1'),
});

export function parseConfiguration(env: Partial<Env>): Configuration {
  try {
    const values = inputSchema.parse(env);
    const url = new URL(values.APP_ORIGIN);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error();
    validateTokenKey({ id: 'session', value: values.SESSION_KEY });
    const tokenKey = { id: values.TOKEN_KEY_ID, value: values.TOKEN_ENCRYPTION_KEY };
    validateTokenKey(tokenKey);
    if (values.SESSION_KEY === tokenKey.value) throw new Error();
    return {
      origin: url.origin,
      ownerEmail: values.OWNER_EMAIL,
      sessionKey: values.SESSION_KEY,
      tokenKey,
      google: {
        clientId: values.GOOGLE_CLIENT_ID,
        clientSecret: values.GOOGLE_CLIENT_SECRET,
        redirectUri: `${url.origin}/auth/google/callback`,
      },
    };
  } catch {
    throw new AppError(
      'installation_unavailable',
      'this installation needs its owner configuration and server keys before sign-in is available.',
      503,
    );
  }
}
