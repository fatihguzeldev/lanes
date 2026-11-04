export interface PortabilityLanding {
  tab: 'import' | 'export';
  accountId: string;
  sourceAccountId?: string;
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
