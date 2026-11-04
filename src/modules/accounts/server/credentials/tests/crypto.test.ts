import { describe, expect, it } from 'vitest';
import {
  TokenCryptoError,
  createPkce,
  decryptToken,
  encryptToken,
  hashToken,
  pkceChallenge,
  randomToken,
  signHmac,
  verifyHmac,
} from '../crypto';

const key = { id: 'primary', value: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
const otherKey = { id: 'primary', value: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE' };
const context = 'account:google-subject-1:refresh';

describe('stored-token encryption', () => {
  it('round-trips unicode without storing plaintext and produces a fresh IV each time', async () => {
    const plaintext = 'refresh-token-öğrenmek-🪴';
    const first = await encryptToken(plaintext, key, context);
    const second = await encryptToken(plaintext, key, context);
    expect(first).not.toContain(plaintext);
    expect(first).not.toBe(second);
    expect(JSON.parse(first)).toMatchObject({ version: 1, keyId: 'primary' });
    await expect(decryptToken(first, key, context)).resolves.toBe(plaintext);
  });

  it('rejects a modified ciphertext', async () => {
    const envelope = JSON.parse(await encryptToken('sensitive grant', key, context)) as {
      ciphertext: string;
    };
    const first = envelope.ciphertext[0];
    envelope.ciphertext = (first === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
    await expect(decryptToken(JSON.stringify(envelope), key, context)).rejects.toMatchObject({
      code: 'token_decryption_failed',
    });
  });

  it('rejects another encryption key even when its key id is the same', async () => {
    const encrypted = await encryptToken('sensitive grant', key, context);
    await expect(decryptToken(encrypted, otherKey, context)).rejects.toMatchObject({
      code: 'token_decryption_failed',
    });
  });

  it('reports a key-id mismatch without silently trying another key', async () => {
    const encrypted = await encryptToken('sensitive grant', key, context);
    await expect(
      decryptToken(encrypted, { ...key, id: 'replacement' }, context),
    ).rejects.toMatchObject({
      code: 'token_key_mismatch',
    });
  });

  it('binds ciphertext to the account and field that own it', async () => {
    const encrypted = await encryptToken('sensitive grant', key, context);
    await expect(
      decryptToken(encrypted, key, 'account:google-subject-2:refresh'),
    ).rejects.toBeInstanceOf(TokenCryptoError);
    await expect(
      decryptToken(encrypted, key, 'account:google-subject-1:access'),
    ).rejects.toBeInstanceOf(TokenCryptoError);
  });

  it('rejects unsupported envelopes and invalid key configuration without exposing values', async () => {
    const encrypted = JSON.parse(await encryptToken('sensitive grant', key, context)) as Record<
      string,
      unknown
    >;
    await expect(
      decryptToken(JSON.stringify({ ...encrypted, version: 2 }), key, context),
    ).rejects.toMatchObject({
      code: 'token_envelope_invalid',
    });
    await expect(
      encryptToken('sensitive grant', { id: 'primary', value: 'invalid-secret' }, context),
    ).rejects.toMatchObject({
      code: 'token_key_invalid',
    });
  });
});

describe('oauth and session primitives', () => {
  it('matches the RFC 7636 S256 challenge vector', async () => {
    await expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('creates independent cryptographic states and PKCE verifiers', async () => {
    const first = randomToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(first);
    const pkce = await createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.method).toBe('S256');
    await expect(pkceChallenge(pkce.verifier)).resolves.toBe(pkce.challenge);
  });

  it('hashes opaque session tokens and authenticates HMAC messages with native crypto', async () => {
    expect(await hashToken('one')).not.toBe(await hashToken('two'));
    const signature = await signHmac('session.payload', key.value);
    await expect(verifyHmac('session.payload', signature, key.value)).resolves.toBe(true);
    await expect(verifyHmac('changed.payload', signature, key.value)).resolves.toBe(false);
    await expect(verifyHmac('session.payload', signature, otherKey.value)).resolves.toBe(false);
    await expect(verifyHmac('session.payload', 'not+a+signature', key.value)).resolves.toBe(false);
  });
});
