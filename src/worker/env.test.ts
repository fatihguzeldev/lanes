import { describe, expect, it } from 'vitest';
import { parseConfiguration } from './env';

const valid = {
  APP_ORIGIN: 'https://lanes.example.workers.dev',
  OWNER_EMAIL: 'owner@example.com',
  GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'secret',
  SESSION_KEY: 'A'.repeat(43),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
  TOKEN_KEY_ID: 'v1',
};
describe('closed installation configuration', () => {
  it('does not expose sign-in without an intended owner', () => {
    expect(() => parseConfiguration({ ...valid, OWNER_EMAIL: '' })).toThrow('installation');
  });
  it('requires real random-key-sized values without echoing them', () => {
    expect(() => parseConfiguration({ ...valid, SESSION_KEY: 'short-private-value' })).toThrow(
      'installation',
    );
    try {
      parseConfiguration({ ...valid, SESSION_KEY: 'short-private-value' });
    } catch (error) {
      expect(String(error)).not.toContain('short-private-value');
    }
  });
  it('rejects nonlocal http, paths, credentials and deceptive callback origins', () => {
    for (const APP_ORIGIN of [
      'http://example.com',
      'https://example.com/a',
      'https://user:pass@example.com',
      'https://example.com/?a=b',
      'https://example.com/#x',
    ]) {
      expect(() => parseConfiguration({ ...valid, APP_ORIGIN })).toThrow();
    }
  });
  it('derives one exact callback and normalizes bootstrap email only', () => {
    const value = parseConfiguration({ ...valid, OWNER_EMAIL: ' Owner@Example.com ' });
    expect(value.google.redirectUri).toBe('https://lanes.example.workers.dev/auth/google/callback');
    expect(value.ownerEmail).toBe('owner@example.com');
  });
  it('permits local development without enabling insecure remote callbacks', () => {
    expect(parseConfiguration({ ...valid, APP_ORIGIN: 'http://127.0.0.1:5173' }).origin).toBe(
      'http://127.0.0.1:5173',
    );
  });
});
