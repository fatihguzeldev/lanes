import { expect, it } from 'vitest';
import {
  decodeSheetsExportDraft,
  canAdvanceSheetsRun,
  canConfirmSheetsRun,
  spreadsheetHref,
  describeSheetsScope,
} from './export-state';
import type { SheetsExportSummary } from '../../export-contract';
const now = Date.parse('2026-11-03T12:00:00Z');
const input = {
  exportId: 'abcdefghijklmnop',
  scope: { query: 'buy', filter: {} },
  includeCompleted: true,
  today: '2026-11-03',
};
it('retains only validated account-bound scope/title across optional consent and expires stale or malformed drafts', () => {
  const raw = JSON.stringify({
    version: 1,
    accountId: 'a',
    title: 'a personal export',
    exportRequest: input,
    savedAt: now,
  });
  expect(decodeSheetsExportDraft(raw, 'a', now)?.exportRequest?.scope.query).toBe('buy');
  expect(decodeSheetsExportDraft(raw, 'b', now)).toBeNull();
  expect(decodeSheetsExportDraft(raw, 'a', now + 86400001)).toBeNull();
  expect(
    decodeSheetsExportDraft(
      JSON.stringify({ ...JSON.parse(raw), accessToken: 'secret' }),
      'a',
      now,
    ),
  ).toBeNull();
  expect(decodeSheetsExportDraft('{bad', 'a', now)).toBeNull();
});
it('never enables automatic continuation/confirmation on unknown outcomes or changed capture evidence', () => {
  const base = {
    state: 'ready',
    captureHash: 'a'.repeat(64),
    operation: null,
  } as SheetsExportSummary;
  expect(canConfirmSheetsRun(base)).toBe(true);
  expect(canConfirmSheetsRun({ ...base, state: 'capturing' })).toBe(false);
  expect(canAdvanceSheetsRun({ ...base, state: 'uncertain' })).toBe(false);
  expect(
    canAdvanceSheetsRun({
      ...base,
      state: 'partial',
      operation: { finished: true } as SheetsExportSummary['operation'],
    }),
  ).toBe(false);
  expect(canAdvanceSheetsRun({ ...base, state: 'running' })).toBe(true);
});
it('uses only exact official spreadsheet file links and explains explicit export scope without live authority', () => {
  expect(
    spreadsheetHref({
      id: 'file_123',
      url: 'https://docs.google.com/spreadsheets/d/file_123/edit',
    }),
  ).toBe('https://docs.google.com/spreadsheets/d/file_123/edit');
  expect(
    spreadsheetHref({ id: 'file_123', url: 'https://evil.example/spreadsheets/d/file_123/edit' }),
  ).toBeNull();
  expect(describeSheetsScope(input)).toContain('search');
  expect(describeSheetsScope({ ...input, scope: { listIds: ['a', 'b'] } })).toContain('2');
});
