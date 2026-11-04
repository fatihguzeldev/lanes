import { AppError } from '../../../shared/contracts/errors';
import { TokenCryptoError } from './credentials/crypto';
import { GoogleOAuthError } from './oauth/google';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
export function invalidState(): AppError {
  return new AppError(
    'forbidden',
    'this google authorization is invalid or expired. start it again.',
    403,
  );
}
export function installationError(): AppError {
  return new AppError(
    'installation_unavailable',
    'the owner or encryption configuration does not match this installation. restore the configured values or follow the owner-change procedure.',
    503,
  );
}
export function convertError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof TokenCryptoError) throw installationError();
  if (error instanceof GoogleOAuthError) {
    switch (error.code) {
      case 'configuration_invalid':
        throw new AppError('installation_unavailable', error.message, 503);
      case 'identity_invalid':
      case 'authorization_failed':
        throw new AppError('forbidden', error.message, 403);
      case 'reconnect_required':
        throw new AppError('reconnect_required', error.message, 409);
      case 'permission_required':
        throw new AppError('permission_required', error.message, 403);
      case 'provider_rate_limited':
        throw new AppError('provider_rate_limited', error.message, 429, error.retryable);
      default:
        throw new AppError('provider_unavailable', error.message, 503, error.retryable);
    }
  }
  throw error;
}
