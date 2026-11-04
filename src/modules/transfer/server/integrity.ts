export function canonicalJson(value: unknown): string {
  const walk = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(walk)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, value]) => value !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, value]) => [key, walk(value)]),
          )
        : value;
  return JSON.stringify(walk(value));
}

export async function transferDigest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
