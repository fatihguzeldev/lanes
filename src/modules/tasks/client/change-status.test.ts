import { describe, expect, it } from 'vitest';
import type { OperationSummary } from '../operation-contract';
import { newestChangeReceipt } from './change-status';

const receipt = (patch: Partial<OperationSummary> = {}): OperationSummary => ({
  id: '1730000000000:abcdefghijklmnop',
  accountId: 'account',
  kind: 'task.create',
  state: 'running',
  createdAt: 1,
  updatedAt: 2,
  cancelRequested: false,
  totalSteps: 1,
  confirmedSteps: 0,
  inputSealed: true,
  error: null,
  nextAttemptAt: null,
  finished: false,
  ...patch,
});
describe('change status freshness', () => {
  it('uses a newer status read after an earlier continue response', () => {
    const latest = receipt();
    const read = receipt({ updatedAt: 3, state: 'succeeded', confirmedSteps: 1, finished: true });
    expect(newestChangeReceipt(read, latest)).toBe(read);
    expect(newestChangeReceipt(latest, read)).toBe(read);
  });
  it('accepts a checked status on equal timestamps and ignores another change', () => {
    const read = receipt({ cancelRequested: true });
    expect(newestChangeReceipt(read, receipt())).toBe(read);
    expect(newestChangeReceipt(read, receipt({ id: 'other', updatedAt: 10 }))).toBe(read);
    expect(newestChangeReceipt(undefined, null)).toBeUndefined();
  });
});
