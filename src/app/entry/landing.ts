export interface PortabilityLanding {
  tab: 'import' | 'export';
  accountId: string;
  sourceAccountId?: string;
}

/** Callback codes choose local copy; provider diagnostics never become screen content. */
export function oauthLandingError(
  search = typeof window === 'undefined' ? '' : window.location.search,
): string {
  const code = new URLSearchParams(search.slice(0, 8192)).get('auth_error');
  switch (code) {
    case 'forbidden':
      return 'google sign-in was not completed. try again with the owner google account.';
    case 'permission_required':
      return 'google did not grant the required permission. continue with google to try again.';
    case 'reconnect_required':
      return 'google did not provide usable background access. continue with google to try again.';
    case 'installation_unavailable':
      return 'this installation needs its google configuration checked before sign-in can finish.';
    case 'provider_unavailable':
    case 'provider_rate_limited':
    case 'provider_response_invalid':
    case 'internal_error':
      return 'sign-in could not finish. try again in a moment.';
    case 'conflict':
    case 'unauthenticated':
      return 'this authorization has ended. continue with google to start again.';
    default:
      return '';
  }
}
/** Only local screen selection travels through OAuth return queries. Account authorization stays server-side. */
export function portabilityLanding(
  search = typeof window === 'undefined' ? '' : window.location.search,
): PortabilityLanding | null {
  if (search.length > 8192) return null;
  const query = new URLSearchParams(search),
    tab = query.get('portability'),
    accountId = query.get('account'),
    source = query.get('source');
  const valid = (value: string | null): value is string =>
    !!value && /^[A-Za-z0-9:_-]{1,256}$/.test(value);
  if ((tab !== 'import' && tab !== 'export') || !valid(accountId)) return null;
  return { tab, accountId, ...(valid(source) ? { sourceAccountId: source } : {}) };
}
