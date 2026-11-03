import { describe, expect, it } from 'vitest';
import { oauthLandingError, portabilityLanding } from './landing';
describe('oauth failure landing', () => {
  it('gives a retryable explanation for denied or incomplete consent', () => {
    expect(oauthLandingError('?auth_error=permission_required')).toContain('permission');
    expect(oauthLandingError('?auth_error=reconnect_required')).toContain('background access');
    expect(oauthLandingError('?auth_error=forbidden')).toContain('owner google account');
  });
  it('never displays an unrecognized provider value or diagnostic', () => {
    expect(oauthLandingError('?auth_error=private-token')).toBe('');
    expect(oauthLandingError('?error_description=private-token')).toBe('');
    expect(oauthLandingError('')).toBe('');
  });
});
describe('oauth portability return selection', () => {
  it('keeps the destination separate from the account granting optional sheets access', () => {
    expect(portabilityLanding('?portability=import&account=destination&source=source')).toEqual({
      tab: 'import',
      accountId: 'destination',
      sourceAccountId: 'source',
    });
    expect(portabilityLanding('?portability=export&account=destination')).toEqual({
      tab: 'export',
      accountId: 'destination',
    });
  });
  it('rejects unsupported screens and malformed identifiers rather than interpreting a return url', () => {
    expect(
      portabilityLanding('?portability=https://elsewhere.example&account=destination'),
    ).toBeNull();
    expect(portabilityLanding('?portability=import&account=//elsewhere.example')).toBeNull();
    expect(portabilityLanding('?portability=import')).toBeNull();
  });
});
