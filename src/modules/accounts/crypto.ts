/** Server-only token encryption. The caller supplies the installation key and account/field context. */
export interface TokenKey {
  id: string;
  /** Exactly 32 random bytes, encoded as unpadded base64url. */
  value: string;
}

export type TokenCryptoErrorCode =
  'token_key_invalid' | 'token_key_mismatch' | 'token_envelope_invalid' | 'token_decryption_failed';

export class TokenCryptoError extends Error {
  readonly name = 'TokenCryptoError';

  constructor(readonly code: TokenCryptoErrorCode) {
    super(
      {
        token_key_invalid: 'the token encryption key configuration is invalid.',
        token_key_mismatch: 'the configured encryption key does not match the stored token key id.',
        token_envelope_invalid: 'the stored token format is invalid or unsupported.',
        token_decryption_failed:
          'the stored token could not be decrypted with this key and account context.',
      }[code],
    );
  }
}

interface TokenEnvelope {
  version: 1;
  keyId: string;
  iv: string;
  ciphertext: string;
}

const encoder = new TextEncoder();
const maxTokenBytes = 65_536;

function base64url(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
    throw new Error('invalid encoding');
  const binary = atob(
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4),
  );
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error('noncanonical encoding');
  return bytes;
}

function keyBytes(value: string): Uint8Array<ArrayBuffer> {
  try {
    const bytes = decodeBase64url(value);
    if (bytes.length !== 32) throw new Error('wrong key length');
    return bytes;
  } catch {
    throw new TokenCryptoError('token_key_invalid');
  }
}

function validateKey(key: TokenKey): void {
  if (typeof key.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key.id))
    throw new TokenCryptoError('token_key_invalid');
}

/** Validate installation configuration without encrypting or exposing key material. */
export function validateTokenKey(key: TokenKey): void {
  validateKey(key);
  keyBytes(key.value);
}

function additionalData(keyId: string, context: string): Uint8Array<ArrayBuffer> {
  if (!context || context.length > 512) throw new TokenCryptoError('token_envelope_invalid');
  return encoder.encode(JSON.stringify(['lanes-token', 1, keyId, context]));
}

export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128)
    throw new RangeError('random token length must be between 16 and 128 bytes.');
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashToken(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new RangeError('invalid PKCE verifier.');
  return hashToken(verifier);
}

export async function createPkce(): Promise<{
  verifier: string;
  challenge: string;
  method: 'S256';
}> {
  const verifier = randomToken();
  return { verifier, challenge: await pkceChallenge(verifier), method: 'S256' };
}

export async function signHmac(message: string, key: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    'raw',
    keyBytes(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64url(
    new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(message))),
  );
}

export async function verifyHmac(
  message: string,
  signature: string,
  key: string,
): Promise<boolean> {
  const imported = await crypto.subtle.importKey(
    'raw',
    keyBytes(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  let decoded: Uint8Array<ArrayBuffer>;
  try {
    decoded = decodeBase64url(signature);
  } catch {
    return false;
  }
  if (decoded.length !== 32) return false;
  return crypto.subtle.verify('HMAC', imported, decoded, encoder.encode(message));
}

export async function encryptToken(
  plaintext: string,
  key: TokenKey,
  context: string,
): Promise<string> {
  validateKey(key);
  const bytes = encoder.encode(plaintext);
  if (bytes.length > maxTokenBytes) throw new TokenCryptoError('token_envelope_invalid');
  const imported = await crypto.subtle.importKey('raw', keyBytes(key.value), 'AES-GCM', false, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(key.id, context), tagLength: 128 },
    imported,
    bytes,
  );
  const envelope: TokenEnvelope = {
    version: 1,
    keyId: key.id,
    iv: base64url(iv),
    ciphertext: base64url(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(envelope);
}

export async function decryptToken(
  serialized: string,
  key: TokenKey,
  context: string,
): Promise<string> {
  validateKey(key);
  const imported = await crypto.subtle.importKey('raw', keyBytes(key.value), 'AES-GCM', false, [
    'decrypt',
  ]);
  let envelope: TokenEnvelope;
  let iv: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    if (serialized.length > 90_000) throw new Error('oversized envelope');
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid envelope');
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'ciphertext,iv,keyId,version' ||
      record.version !== 1 ||
      typeof record.keyId !== 'string' ||
      typeof record.iv !== 'string' ||
      typeof record.ciphertext !== 'string'
    )
      throw new Error('invalid envelope');
    envelope = record as unknown as TokenEnvelope;
    iv = decodeBase64url(envelope.iv);
    ciphertext = decodeBase64url(envelope.ciphertext);
    if (iv.length !== 12 || ciphertext.length < 16 || ciphertext.length > maxTokenBytes + 16)
      throw new Error('invalid lengths');
  } catch {
    throw new TokenCryptoError('token_envelope_invalid');
  }
  if (envelope.keyId !== key.id) throw new TokenCryptoError('token_key_mismatch');
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: additionalData(envelope.keyId, context),
        tagLength: 128,
      },
      imported,
      ciphertext,
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    throw new TokenCryptoError('token_decryption_failed');
  }
}
