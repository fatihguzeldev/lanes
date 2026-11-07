import { EntryBootstrapSchema, type EntryBootstrap } from '../../contracts/session';

export function readEntryBootstrap(
  document: Pick<Document, 'getElementById'>,
): EntryBootstrap | null {
  const value = document.getElementById('lanes-session')?.textContent;
  if (!value) return null;
  try {
    const result = EntryBootstrapSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// Bundle download time must not become apparent server clock skew.
export function documentClockOffset(serverTime: number): number {
  const navigation =
    typeof performance === 'undefined'
      ? undefined
      : (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined);
  const receivedAt = navigation?.responseStart
    ? performance.timeOrigin + navigation.responseStart
    : Date.now();
  return serverTime - receivedAt;
}
