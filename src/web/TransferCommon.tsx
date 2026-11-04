import { useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import type { Board, BoardList } from '../modules/boards/contracts';
import { Icon } from '../ui/Icon';
import { request, checkServerConnection } from './http';
import { BoardListPageSchema, BoardPageSchema } from './schemas';
import { usePagedResource } from './usePagedResource';
import { useServerConnection } from './useServerConnection';
import { serverConnection } from './connectivity';
import { googleAuthorizationHref } from './transfer-client';
import { Select } from '../ui/Select';
export interface TransferProps {
  initialTab?: 'import' | 'export';
  account: ConnectionSummary;
  accounts: readonly ConnectionSummary[];
  clockOffset: number;
  version?: number;
  onChanged?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenOperation?: (operationId: string) => void;
  onOpenTask?: (reference: { accountId: string; taskId: string }) => void;
}
export const transferBase = (accountId: string) =>
  `/api/accounts/${encodeURIComponent(accountId)}/transfer`;
export const accountBase = (accountId: string) => `/api/accounts/${encodeURIComponent(accountId)}`;
export const escaped = encodeURIComponent;
export const pageQuery = (cursor?: string, limit = 10) =>
  `?limit=${limit}${cursor ? `&cursor=${escaped(cursor)}` : ''}`;
export const writable = (account: ConnectionSummary) =>
  !['disconnecting', 'disconnected'].includes(account.state);
export const providerReady = (account: ConnectionSummary) =>
  account.state === 'connected' && account.permissions.tasks;
export const message = (error: unknown) =>
  error instanceof Error ? error.message : 'this action could not finish. your input stays here.';
export function useTransferAction(scope: string) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    active = useRef(false),
    lifetime = useRef(new AbortController());
  useEffect(() => {
    lifetime.current = new AbortController();
    active.current = false;
    setBusy(false);
    setError('');
    return () => lifetime.current.abort();
  }, [scope]);
  async function run<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (active.current) return undefined;
    if (scope !== 'connection' && serverConnection() !== 'reachable') {
      setError(
        serverConnection() === 'incompatible'
          ? 'reload lanes before making another change.'
          : 'check the server connection before continuing. this editor keeps your unsent work.',
      );
      return undefined;
    }
    active.current = true;
    setBusy(true);
    setError('');
    const signal = lifetime.current.signal;
    try {
      return await action(signal);
    } catch (caught) {
      if (!signal.aborted) setError(message(caught));
      return undefined;
    } finally {
      if (!signal.aborted) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  return { busy, error, run, setError, signal: () => lifetime.current.signal };
}
export function useTransferDirty(dirty: boolean, callback: TransferProps['onDirtyChange']) {
  const current = useRef(callback);
  current.current = callback;
  useEffect(() => {
    current.current?.(dirty);
    return () => current.current?.(false);
  }, [dirty]);
}
export function TransferConnection() {
  const connection = useServerConnection(),
    action = useTransferAction('connection');
  return connection === 'reachable' ? null : (
    <p className="transfer__notice">
      {connection === 'incompatible'
        ? 'reload lanes before making another change.'
        : 'the server connection is paused. this editor keeps your unsent work.'}
      <button
        type="button"
        onClick={() => {
          if (connection === 'incompatible') window.location.reload();
          else void action.run(() => checkServerConnection());
        }}
        disabled={action.busy}
      >
        {connection === 'incompatible' ? 'reload' : 'check connection'}
      </button>
      {action.error}
    </p>
  );
}
export function TransferError({ children }: { children: ReactNode }) {
  return children ? (
    <p className="transfer__error" role="alert">
      {children}
    </p>
  ) : null;
}
export function TransferPages({
  resource,
}: {
  resource: {
    status: string;
    error: string;
    loaded: boolean;
    nextCursor: string | null;
    reload: () => Promise<void>;
    loadMore: () => Promise<void>;
  };
}) {
  return (
    <>
      {resource.error && (
        <TransferError>
          {resource.error}
          <button type="button" onClick={() => void resource.reload()}>
            try again
          </button>
        </TransferError>
      )}
      {!resource.loaded && resource.status === 'loading' && (
        <p className="transfer__quiet">loading…</p>
      )}
      {resource.nextCursor && (
        <button
          className="transfer__text"
          type="button"
          disabled={resource.status === 'loading'}
          onClick={() => void resource.loadMore()}
        >
          load more
          <Icon name="down" size={12} />
        </button>
      )}
    </>
  );
}
export function AccountChoice({
  accounts,
  value,
  onChange,
  label,
  disabled = false,
  exclude,
}: {
  accounts: readonly ConnectionSummary[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  disabled?: boolean;
  exclude?: string;
}) {
  return (
    <label>
      {label}
      <Select
        value={value}
        onChange={(selectedValue) => onChange(selectedValue)}
        disabled={disabled}
        aria-label={label}
        options={[
          ...accounts
            .filter((account) => account.id !== exclude)
            .map((account) => ({
              value: account.id,
              label: `${account.email} · ${account.state.replaceAll('_', ' ')}`,
            })),
        ]}
      />
    </label>
  );
}
export function useBoardLists(accountId: string, version = 0) {
  const [boardId, setBoardId] = useState('');
  useEffect(() => setBoardId(''), [accountId]);
  const boards = usePagedResource(
    accountId ? `${accountId}:transfer-boards` : null,
    (cursor, signal) =>
      request(`${accountBase(accountId)}/boards${pageQuery(cursor, 50)}`, BoardPageSchema, {
        signal,
      }),
    (item) => item.id,
    version,
  );
  const selectedBoard = boards.items.find(
    (board) => board.id === boardId && board.accountId === accountId,
  );
  const lists = usePagedResource(
    selectedBoard ? `${accountId}:transfer-lists:${boardId}` : null,
    (cursor, signal) =>
      request(
        `${accountBase(accountId)}/boards/${escaped(boardId)}/lists${pageQuery(cursor, 50)}`,
        BoardListPageSchema,
        { signal },
      ),
    (item) => item.id,
    version,
  );
  return {
    boardId,
    setBoardId,
    boards,
    lists,
    board: selectedBoard,
  };
}
export type BoardLists = ReturnType<typeof useBoardLists>;
export function BoardChoice({
  resource,
  disabled = false,
  label = 'board',
}: {
  resource: BoardLists;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <>
      <label>
        {label}
        <Select
          value={resource.boardId}
          disabled={disabled}
          onChange={(selectedValue) => resource.setBoardId(selectedValue)}
          aria-label={label}
          options={[
            { value: '', label: 'choose a board' },
            ...resource.boards.items.map((board) => ({
              value: board.id,
              label: `${board.title}${board.isMain ? ' · main' : ''}`,
            })),
          ]}
        />
      </label>
      <TransferPages resource={resource.boards} />
    </>
  );
}
export function ListSelection({
  resource,
  selected,
  onChange,
  maximum,
  disabled = false,
}: {
  resource: BoardLists;
  selected: readonly BoardList[];
  onChange: (lists: BoardList[]) => void;
  maximum: number;
  disabled?: boolean;
}) {
  return (
    <>
      <BoardChoice resource={resource} disabled={disabled} />
      {resource.boardId && (
        <>
          <div className="transfer__checklist">
            {resource.lists.items.map((list) => (
              <label className="transfer__check" key={list.id}>
                <input
                  type="checkbox"
                  checked={selected.some((item) => item.id === list.id)}
                  disabled={
                    disabled ||
                    (!selected.some((item) => item.id === list.id) && selected.length >= maximum)
                  }
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, list]
                        : selected.filter((item) => item.id !== list.id),
                    )
                  }
                />
                {list.title}
              </label>
            ))}
          </div>
          <TransferPages resource={resource.lists} />
        </>
      )}
      <p>
        {selected.length} lists selected · maximum {maximum}. selections from other boards remain
        selected.
      </p>
      {selected.length > 0 && (
        <div className="transfer__chips">
          {selected.map((list) => (
            <button
              type="button"
              key={list.id}
              disabled={disabled}
              onClick={() => onChange(selected.filter((item) => item.id !== list.id))}
            >
              {list.title}
              <Icon name="close" size={11} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}
export function DestinationChoice({
  resource,
  kind,
  setKind,
  listId,
  setListId,
  disabled,
}: {
  resource: BoardLists;
  kind: 'new' | 'existing';
  setKind: (kind: 'new' | 'existing') => void;
  listId: string;
  setListId: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <label>
        destination
        <Select
          value={kind}
          onChange={(selectedValue) => setKind(selectedValue as 'new' | 'existing')}
          aria-label="destination"
          options={[
            { value: 'new', label: 'create distinct new lists' },
            { value: 'existing', label: 'append to an existing list' },
          ]}
        />
      </label>
      <BoardChoice resource={resource} label="destination board" />
      {kind === 'existing' && (
        <>
          <label>
            destination list
            <Select
              value={listId}
              onChange={(selectedValue) => setListId(selectedValue)}
              aria-label="destination list"
              options={[
                { value: '', label: 'choose a list' },
                ...resource.lists.items.map((list) => ({ value: list.id, label: list.title })),
              ]}
            />
          </label>
          {resource.boardId && <TransferPages resource={resource.lists} />}
        </>
      )}
      <p>
        {kind === 'new'
          ? 'equal titles create separate lists; existing content is preserved.'
          : 'mapped list names will not change this explicit destination. no list slot is consumed.'}
      </p>
    </fieldset>
  );
}
export function destinationValue(resource: BoardLists, kind: 'new' | 'existing', listId: string) {
  if (kind === 'new') {
    if (!resource.board) throw new Error('choose a loaded destination board.');
    return { kind, boardId: resource.board.id, boardRevision: resource.board.revision } as const;
  }
  const list = resource.lists.items.find((list) => list.id === listId);
  if (!list) throw new Error('choose a loaded destination list.');
  return { kind, listId: list.id, revision: list.revision } as const;
}
export async function sheetsConsent(
  accountId: string,
  purpose: 'sheets_import' | 'sheets_export',
  signal: AbortSignal,
  destinationAccountId = accountId,
) {
  const result = await request(
    '/auth/google/start',
    z.object({ authorizationUrl: z.string().url() }).strict(),
    {
      method: 'POST',
      body: {
        purpose,
        accountId,
        returnPath: `/?portability=${purpose === 'sheets_import' ? 'import' : 'export'}&account=${escaped(destinationAccountId)}&source=${escaped(accountId)}`,
      },
      signal,
    },
  );
  window.location.assign(googleAuthorizationHref(result.authorizationUrl));
}
export type { Board, BoardList };
