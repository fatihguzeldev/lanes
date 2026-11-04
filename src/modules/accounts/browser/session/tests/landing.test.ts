import { describe, expect, it } from 'vitest';
import { oauthLandingError } from '../landing';
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
