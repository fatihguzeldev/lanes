import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../contracts/errors';
import type { ConnectionSummary } from '../../modules/accounts/contracts';
import { GOOGLE_SHEETS_IMPORT_SCOPE } from '../../modules/transfer/server/sheets';
import type { Services } from '../services';
import { transferRoute } from './transfer';

const account = {
  id: 'destination',
  email: 'owner@example.com',
  displayName: 'owner',
  pictureUrl: null,
  state: 'connected',
  permissions: { tasks: true, sheetsImport: true, sheetsExport: true },
  grantExpiresAt: null,
  planningZone: 'UTC',
  weekStart: 1,
  revision: 1,
} satisfies ConnectionSummary;

function call(path: string, services: unknown, input?: unknown) {
  const url = new URL(`/api/accounts/destination/transfer/${path}`, 'https://lanes.example');
  const request = new Request(url, {
    method: input === undefined ? 'GET' : 'POST',
    ...(input === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  });
  return transferRoute(
    request,
    url,
    url.pathname.split('/').filter(Boolean),
    account,
    'owner-subject',
    services as Services,
  );
}

describe('account-scoped transfer HTTP protocols', () => {
  it('retains bounded archive pagination and the authenticated account scope', async () => {
    const list = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const services = { transfer: { archiveExports: { list } } };
    await expect(call('archives/exports?limit=11', services)).rejects.toMatchObject({
      code: 'validation_failed',
      status: 400,
    });
    expect(list).not.toHaveBeenCalled();
    const response = await call('archives/exports?limit=10&cursor=next-page', services);
    expect(await response!.json()).toEqual({ items: [], nextCursor: null });
    expect(list).toHaveBeenCalledExactlyOnceWith('destination', { limit: 10, cursor: 'next-page' });
  });

  it('validates one sheet reference before requesting its account-specific import scope', async () => {
    const metadata = vi.fn().mockResolvedValue({ spreadsheetId: 'sheet', title: 'planning' });
    const sheetsClientFor = vi.fn().mockResolvedValue({ metadata });
    const services = { transfer: {}, sheetsClientFor };
    await expect(
      call('sheets/metadata', services, { spreadsheetId: 'sheet', url: 'another-reference' }),
    ).rejects.toMatchObject({ code: 'validation_failed', status: 400 });
    expect(sheetsClientFor).not.toHaveBeenCalled();
    const response = await call('sheets/metadata', services, { spreadsheetId: 'sheet' });
    expect(await response!.json()).toEqual({ spreadsheetId: 'sheet', title: 'planning' });
    expect(sheetsClientFor).toHaveBeenCalledExactlyOnceWith(
      'destination',
      GOOGLE_SHEETS_IMPORT_SCOPE,
    );
    expect(metadata).toHaveBeenCalledExactlyOnceWith('sheet');
  });

  it('requires source-account access before admitting an account transfer', async () => {
    const getConnectionSummary = vi
      .fn()
      .mockRejectedValue(new AppError('forbidden', 'this source is not available.', 403));
    const begin = vi.fn();
    const services = {
      accounts: { getConnectionSummary },
      transfer: { accountTransfers: { begin } },
    };
    const input = {
      id: '1793800000000:transfer-admission',
      sourceAccountId: 'source',
      listIds: ['list'],
    };
    await expect(call('accounts', services, input)).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
    expect(getConnectionSummary).toHaveBeenCalledOnce();
    expect(getConnectionSummary.mock.calls[0]![1]).toBe('source');
    expect(begin).not.toHaveBeenCalled();
    getConnectionSummary.mockResolvedValue(account);
    begin.mockResolvedValue({ id: input.id });
    const response = await call('accounts', services, input);
    expect(response!.status).toBe(202);
    expect(begin).toHaveBeenCalledExactlyOnceWith({
      ...input,
      includeCompleted: true,
      ownerSubject: 'owner-subject',
      destinationAccountId: 'destination',
    });
  });

  it('repairs a recorded sheet response without selecting a fresh export attempt', async () => {
    const resumeRecordedResponse = vi.fn().mockResolvedValue({ state: 'succeeded' });
    const startFreshAttempt = vi.fn();
    const services = {
      transfer: { sheetsExports: { resumeRecordedResponse, startFreshAttempt } },
    };
    const response = await call('exports/sheets/export-id/resolution/repair', services, {
      stepKey: 'rows-20',
    });
    expect(await response!.json()).toEqual({ state: 'succeeded' });
    expect(resumeRecordedResponse).toHaveBeenCalledExactlyOnceWith(
      'destination',
      'export-id',
      'rows-20',
    );
    expect(startFreshAttempt).not.toHaveBeenCalled();
  });
});
