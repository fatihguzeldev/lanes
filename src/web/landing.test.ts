import { describe, expect, it } from 'vitest';
import { portabilityLanding } from './landing';
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
