import { expect, it } from 'vitest';
import { googleAuthorizationHref } from '../consent';
it('accepts only the expected Google authorization destination', () => {
  expect(googleAuthorizationHref('https://accounts.google.com/o/oauth2/v2/auth?state=opaque')).toBe(
    'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
  );
  for (const url of [
    'http://accounts.google.com/auth',
    'https://accounts.google.com.attacker.example/auth',
    'javascript:alert(1)',
    'https://user:password@accounts.google.com/auth',
    'https://accounts.google.com:8443/auth',
  ])
    expect(() => googleAuthorizationHref(url)).toThrow();
});
