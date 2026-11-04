import { useEffect, useRef, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import {
  SheetsExportRequestSchema,
  SheetsExportSummarySchema,
  type CsvExportRequest,
  type SheetsExportRequest,
  type SheetsExportSummary,
} from '../../export-contract';
import { request } from '../../../../shared/browser/http/http';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { usePagedResource } from '../../../../shared/browser/resources/usePagedResource';
import { transferPage } from '../response-contracts';
import { escaped, pageQuery, transferBase, writable } from '../transfer-context';
import { sheetsConsent } from './consent';
import { TransferConnection, TransferError, TransferPages } from '../TransferFeedback';
import { useTransferAction } from '../useTransferAction';
import { useTransferDirty } from '../useTransferDirty';
import {
  readSheetsExportDraft,
  saveSheetsExportDraft,
  clearSheetsExportDraft,
  canAdvanceSheetsRun,
  canConfirmSheetsRun,
  describeSheetsScope,
} from './export-state';
import { TransferSheetsRun } from './TransferSheetsRun';
import { TransferSheetsRecovery } from './TransferSheetsRecovery';
import './TransferSheetsExport.css';
export interface TransferSheetsExportProps {
  account: ConnectionSummary;
  clockOffset: number;
  exportRequest?: CsvExportRequest;
  initialRun?: SheetsExportSummary;
  onChanged?: () => void;
  onOpenOperation?: (id: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}
export function TransferSheetsExport({
  account,
  clockOffset,
  exportRequest,
  initialRun,
  onChanged,
  onOpenOperation,
  onDirtyChange,
}: TransferSheetsExportProps) {
  const currentAccount = useRef(account.id);
  currentAccount.current = account.id;
  const draft = useRef(readSheetsExportDraft(account.id)),
    [title, setTitle] = useState(draft.current?.title ?? 'lanes tasks'),
    [edited, setEdited] = useState(false),
    [run, setRun] = useState<SheetsExportSummary | null>(initialRun ?? null),
    [acknowledged, setAcknowledged] = useState(false),
    [notice, setNotice] = useState(''),
    [version, setVersion] = useState(0),
    pending = useRef<SheetsExportRequest | null>(null),
    frozenScope = useRef<CsvExportRequest | undefined>(draft.current?.exportRequest),
    action = useTransferAction(account.id + ':' + (initialRun?.id ?? 'new'));
  const base = transferBase(account.id) + '/exports/sheets',
    saved = usePagedResource(
      account.id + ':retained-sheets-exports',
      (cursor, signal) =>
        request(base + pageQuery(cursor), transferPage(SheetsExportSummarySchema), { signal }),
      (item) => item.id,
      version,
    ),
    scope = run?.selection ?? pending.current?.export ?? exportRequest ?? frozenScope.current,
    draftOnly =
      (!!pending.current && !run) || (!!run && ['capturing', 'ready'].includes(run.state));
  useTransferDirty(draftOnly || (edited && !run), onDirtyChange);
  useEffect(() => {
    draft.current = readSheetsExportDraft(account.id);
    frozenScope.current = draft.current?.exportRequest;
    pending.current = null;
    setRun(initialRun ?? null);
    setTitle(draft.current?.title ?? 'lanes tasks');
    setAcknowledged(false);
    setEdited(false);
    setNotice('');
    if (!initialRun && draft.current?.operationId) {
      const id = draft.current.operationId,
        controller = new AbortController();
      if (draft.current.exportRequest)
        pending.current = {
          operationId: id,
          title: draft.current.title,
          export: draft.current.exportRequest,
        };
      void request(base + '/' + escaped(id), SheetsExportSummarySchema, {
        signal: controller.signal,
      })
        .then((value) => {
          if (value.accountId !== currentAccount.current || controller.signal.aborted) return;
          setRun(value);
          pending.current = null;
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setNotice(
              'a saved capture could not be read. inspect saved exports or replay the same capture before starting another.',
            );
        });
      return () => controller.abort();
    }
  }, [account.id, initialRun?.id]);
  useEffect(() => {
    if (!run || !canAdvanceSheetsRun(run)) return;
    const controller = new AbortController(),
      timer = setInterval(() => {
        void request(base + '/' + escaped(run.id), SheetsExportSummarySchema, {
          signal: controller.signal,
        })
          .then((value) => {
            if (value.accountId === currentAccount.current && !controller.signal.aborted)
              setRun(value);
          })
          .catch(() => {});
      }, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [run?.id, run?.state]);
  function received(value: SheetsExportSummary) {
    if (value.accountId !== currentAccount.current) return;
    setRun(value);
    setAcknowledged(false);
    setVersion((prior) => prior + 1);
    onChanged?.();
    if (value.selection) frozenScope.current = value.selection;
  }
  function remember() {
    const selected =
      run?.selection ?? pending.current?.export ?? exportRequest ?? frozenScope.current;
    saveSheetsExportDraft(account.id, {
      title: run?.title ?? pending.current?.title ?? title,
      ...(selected ? { exportRequest: selected } : {}),
      ...(run?.id || pending.current?.operationId
        ? { operationId: run?.id ?? pending.current!.operationId }
        : {}),
    });
  }
  async function authorize() {
    remember();
    await action.run((signal) => sheetsConsent(account.id, 'sheets_export', signal));
  }
  async function capture(signal: AbortSignal) {
    let current = run;
    if (!current) {
      if (!pending.current) {
        const selected = exportRequest ?? frozenScope.current;
        if (!selected) throw Error('choose an explicit export scope first.');
        pending.current = SheetsExportRequestSchema.parse({
          operationId: newOperationId(clockOffset),
          title,
          export: { ...selected, exportId: crypto.randomUUID().replaceAll('-', '') },
        });
        frozenScope.current = pending.current.export;
        try {
          remember();
        } catch {
          setNotice(
            'this browser could not keep a consent draft. the server capture remains recoverable in saved exports.',
          );
        }
      }
      current = await request(base, SheetsExportSummarySchema, {
        method: 'POST',
        body: pending.current,
        signal,
      });
      if (current.accountId !== currentAccount.current || signal.aborted) return;
      setRun(current);
      if (pending.current?.operationId === current.id) pending.current = null;
    }
    const deadline = Date.now() + 30000;
    for (
      let slice = 0;
      current.state === 'capturing' && slice < 20 && Date.now() < deadline && !signal.aborted;
      slice++
    ) {
      current = await request(
        base + '/' + escaped(current.id) + '/capture',
        SheetsExportSummarySchema,
        { method: 'POST', body: {}, signal },
      );
      if (current.accountId !== currentAccount.current || signal.aborted) return;
      setRun(current);
    }
    received(current);
  }
  async function advance(signal: AbortSignal, current: SheetsExportSummary) {
    const deadline = Date.now() + 30000;
    for (
      let slice = 0;
      canAdvanceSheetsRun(current) && slice < 12 && Date.now() < deadline && !signal.aborted;
      slice++
    ) {
      if ((current.operation?.nextAttemptAt ?? 0) > Date.now() + clockOffset) break;
      current = await request(
        base + '/' + escaped(current.id) + '/advance',
        SheetsExportSummarySchema,
        { method: 'POST', body: {}, signal },
      );
      if (current.accountId !== currentAccount.current || signal.aborted) return;
      setRun(current);
    }
    received(current);
  }
  async function confirm(signal: AbortSignal) {
    if (!run || !canConfirmSheetsRun(run) || !acknowledged)
      throw Error('review and confirm this exact captured export first.');
    const confirmed = await request(
      base + '/' + escaped(run.id) + '/confirm',
      SheetsExportSummarySchema,
      { method: 'POST', body: { captureHash: run.captureHash }, signal },
    );
    received(confirmed);
    clearSheetsExportDraft(account.id);
    await advance(signal, confirmed);
  }
  const busy = action.busy,
    allowed = writable(account);
  return (
    <section className="transfer__form sheets-export">
      <TransferConnection />
      <h3>take it to google sheets</h3>
      <p>
        create a new spreadsheet under {account.email}. plain text is written as raw values,
        including formula-like task titles; existing files are preserved.
      </p>
      {!run && (
        <fieldset disabled={busy}>
          <label>
            new spreadsheet title
            <input
              value={title}
              maxLength={1024}
              onChange={(event) => {
                setTitle(event.target.value);
                setEdited(true);
              }}
              disabled={!!pending.current}
            />
          </label>
          {scope ? (
            <p>{describeSheetsScope(scope)}</p>
          ) : (
            <p>
              open a saved export below, or choose a list, board or search scope to prepare a new
              one.
            </p>
          )}
          <button
            type="button"
            className="transfer__secondary"
            disabled={busy || !allowed || !scope || !title.trim()}
            onClick={() => void action.run(capture)}
          >
            {pending.current ? 'replay the same saved capture' : 'capture rows for review'}
          </button>
        </fieldset>
      )}
      {run && <TransferSheetsRun run={run} {...(onOpenOperation ? { onOpenOperation } : {})} />}
      <details className="transfer__details">
        <summary>
          {account.permissions.sheetsExport
            ? 'sheets permission and account'
            : 'authorize sheets export'}
        </summary>
        <p>
          export requests drive.file only. this permits files created or authorized through this
          app; it does not grant broad drive access. denying it keeps google tasks usable.
        </p>
        <button
          type="button"
          disabled={busy || !allowed}
          onClick={() => {
            void authorize().catch((error) =>
              action.setError(
                error instanceof Error ? error.message : 'the consent draft could not be saved.',
              ),
            );
          }}
        >
          authorize or renew sheets export
        </button>
        {!allowed && <p>reconnect this account before authorizing or creating a spreadsheet.</p>}
      </details>
      {notice && <p className="transfer__notice">{notice}</p>}
      {run?.state === 'capturing' && (
        <button type="button" disabled={busy || !allowed} onClick={() => void action.run(capture)}>
          continue capturing the same selection
        </button>
      )}
      {run && canConfirmSheetsRun(run) && (
        <>
          <label className="transfer__check">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            create one new spreadsheet from these {run.totalRows} captured task rows
          </label>
          <button
            type="button"
            className="transfer__primary"
            disabled={busy || !allowed || !acknowledged || !account.permissions.sheetsExport}
            onClick={() => void action.run(confirm)}
          >
            create the new spreadsheet
          </button>
          {!account.permissions.sheetsExport && (
            <p>
              authorize sheets export before creating the file. the captured selection stays here.
            </p>
          )}
        </>
      )}
      {run && canAdvanceSheetsRun(run) && (
        <button
          type="button"
          className="transfer__primary"
          disabled={busy || !allowed}
          onClick={() => void action.run((signal) => advance(signal, run))}
        >
          continue this saved export
        </button>
      )}
      {run && ['reconnect_required', 'blocked_by_limit'].includes(run.state) && (
        <button
          type="button"
          disabled={busy || !allowed}
          onClick={() =>
            void action.run(async (signal) => {
              const resumed = await request(
                base + '/' + escaped(run.id) + '/resume',
                SheetsExportSummarySchema,
                { method: 'POST', body: {}, signal },
              );
              received(resumed);
              await advance(signal, resumed);
            })
          }
        >
          resume after permission or limit recovery
        </button>
      )}
      {run?.state === 'uncertain' && (
        <TransferSheetsRecovery
          run={run}
          clockOffset={clockOffset}
          onUpdated={received}
          onPermission={() => {
            void authorize().catch((error) =>
              action.setError(error instanceof Error ? error.message : 'consent could not start.'),
            );
          }}
          disabled={busy || !allowed}
        />
      )}
      <div className="transfer__actions">
        {run && !['succeeded', 'cancelled', 'failed'].includes(run.state) && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void action.run(async (signal) => {
                received(
                  await request(
                    base + '/' + escaped(run.id) + '/cancel',
                    SheetsExportSummarySchema,
                    { method: 'POST', body: {}, signal },
                  ),
                );
                clearSheetsExportDraft(account.id);
              })
            }
          >
            cancel only unsent remaining work
          </button>
        )}
        {run && ['succeeded', 'cancelled', 'failed'].includes(run.state) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setRun(null);
              pending.current = null;
              frozenScope.current = exportRequest;
              clearSheetsExportDraft(account.id);
              setEdited(false);
              setAcknowledged(false);
            }}
          >
            prepare another export
          </button>
        )}
      </div>
      <details className="transfer__details">
        <summary>saved sheets exports</summary>
        <TransferPages resource={saved} />
        {!saved.items.length && saved.loaded && <p>no saved sheets exports yet.</p>}
        <div className="sheets-export__saved">
          {saved.items.map((item) => (
            <button
              type="button"
              key={item.id}
              disabled={busy || (draftOnly && item.id !== run?.id)}
              onClick={() => {
                pending.current = null;
                received(item);
                setNotice('');
              }}
            >
              {item.title ?? 'saved export'} · {item.state.replaceAll('_', ' ')} ·{' '}
              {item.confirmedRows}/{item.totalRows}
            </button>
          ))}
        </div>
      </details>
      <TransferError>{action.error}</TransferError>
    </section>
  );
}
