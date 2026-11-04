import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { z } from 'zod';
import type { ConnectionSummary } from '../modules/accounts/contracts';
import type { Board } from '../modules/boards/contracts';
import {
  ApplyTemplateSchema,
  BoardTemplateSummarySchema,
  CreateTemplateScheduleSchema,
  TemplateRunSummarySchema,
  TemplateScheduleSummarySchema,
  type BoardTemplateSummary,
  type TemplateReference,
  type TemplateRunSummary,
  type TemplateScheduleSummary,
} from '../modules/boards/template-contract';
import {
  BoardTemplateSourceSchema,
  ListTemplateSourceSchema,
  TemplateCommandSchema,
  type TemplateCommand,
} from '../modules/boards/template-command-contract';
import {
  ListTemplateSummarySchema,
  SnapshotSummarySchema,
  TemplateApplicationOptionsSchema,
  TemplateDocumentSchema,
  TemplateListSchema,
  TemplateTaskSchema,
  type ListTemplateSummary,
  type SnapshotSummary,
  type TemplateTask,
} from '../modules/tasks/template-contract';
import { TemplateScheduleSchema } from '../modules/tasks/planning-contract';
import {
  accountToday,
  addCalendarDays,
  latestTemplateSlot,
  nextTemplateSlot,
} from '../modules/tasks/planning';
import { OperationSummarySchema, type OperationSummary } from '../modules/tasks/operation-contract';
import { Dialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { checkServerConnection, request, RequestError } from '../client/http';
import { BoardListPageSchema, BoardPageSchema } from './schemas';
import { usePagedResource } from '../client/usePagedResource';
import { newOperationId } from '../client/operation-identity';
import { useCommands } from './useCommands';
import { useServerConnection } from '../client/useServerConnection';
import { Select } from '../ui/Select';
import { TimeZoneSelect } from '../ui/TimeZoneSelect';
import './TemplateWorkspace.css';
type PersonalTemplate = ListTemplateSummary | BoardTemplateSummary;
type Kind = PersonalTemplate['kind'];
type Tab = 'personal' | 'gallery' | 'schedules' | 'runs';
const CoverageSchema = z
  .object({ complete: z.boolean(), stale: z.boolean(), lastSyncedAt: z.string().nullable() })
  .strict();
const page = <S extends z.ZodType>(schema: S) =>
  z
    .object({
      items: z.array(schema).max(100),
      nextCursor: z.string().nullable(),
      coverage: CoverageSchema,
    })
    .strict();
const ListPageSchema = page(ListTemplateSummarySchema),
  BoardTemplatePageSchema = page(BoardTemplateSummarySchema);
const SchedulePageSchema = page(TemplateScheduleSummarySchema),
  RunPageSchema = page(TemplateRunSummarySchema);
const GallerySchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            document: TemplateDocumentSchema,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
type Gallery = z.infer<typeof GallerySchema>['items'];
const SourcePreviewSchema = SnapshotSummarySchema.omit({ id: true, createdAt: true });
type SourcePreview = z.infer<typeof SourcePreviewSchema>;
const count = z.number().int().nonnegative();
const PreviewSchema = z
  .object({
    labelDefinitionCount: count,
    labelColorConflictCount: count,
    listCount: count,
    taskCount: count,
    requiredListSlots: count,
    omittedDependencyCount: count,
    omittedDates: count,
    omittedTimes: count,
    omittedRepeatRules: count,
    negativeDateCount: count,
  })
  .strict();
const CapacitySchema = z
  .object({
    known: count.nullable(),
    reserved: count,
    available: count.nullable(),
    stale: z.boolean(),
  })
  .strict();
const ApplicationPreviewSchema = z
  .object({ preview: PreviewSchema, capacity: CapacitySchema })
  .strict();
type Capacity = z.infer<typeof CapacitySchema>;
const ConflictPageSchema = page(
  z.object({ name: z.string(), requestedColor: z.string(), keptColor: z.string() }).strict(),
);
const ref = (template: PersonalTemplate): TemplateReference => ({
  kind: template.kind,
  id: template.id,
  contentRevision: template.contentRevision,
});
const query = (cursor?: string, limit = 50) =>
  `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
const baseFor = (accountId: string) => `/api/accounts/${encodeURIComponent(accountId)}`;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'this action could not finish. your draft stays here.';
const localWritable = (account: ConnectionSummary) =>
  account.state !== 'disconnecting' && account.state !== 'disconnected';
const providerWritable = (account: ConnectionSummary) =>
  account.state === 'connected' && account.permissions.tasks;
export function applicationCapacityMessage(required: number, capacity: Capacity): string {
  if (capacity.stale || capacity.known === null || capacity.available === null)
    return 'refresh the list inventory before creating this copy.';
  return required > capacity.available
    ? `this copy needs ${required} list slots; ${capacity.available} are available. reserved work already uses ${capacity.reserved} slots.`
    : '';
}
export function templateTaskDate(
  task: Pick<TemplateTask, 'dayOffset' | 'scheduledTime' | 'timeZone'>,
  day: string,
  relative: boolean,
): string {
  if (!relative || task.dayOffset === null) return 'no date';
  try {
    return `${addCalendarDays(day, task.dayOffset)}${task.scheduledTime ? ` · ${task.scheduledTime} ${task.timeZone ?? ''}` : ''}`;
  } catch {
    return 'choose a valid application day';
  }
}
interface InputIdentity {
  fingerprint: string;
  id: string;
}
export function unchangedInputIdentity(
  prior: InputIdentity | null,
  input: unknown,
  create: () => string,
): InputIdentity {
  const fingerprint = JSON.stringify(input);
  return prior?.fingerprint === fingerprint ? prior : { fingerprint, id: create() };
}
export interface TemplateWorkspaceProps {
  account: ConnectionSummary;
  clockOffset: number;
  version?: number;
  onChanged?: () => void;
  onOpenOperation?: (operationId: string) => void;
  onRefreshInventory?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}
type Modal =
  | {
      kind: 'save';
      template?: PersonalTemplate;
    }
  | {
      kind: 'manage' | 'apply';
      template: PersonalTemplate;
    }
  | {
      kind: 'schedule';
      template?: PersonalTemplate;
      schedule?: TemplateScheduleSummary;
    }
  | {
      kind: 'run';
      run: TemplateRunSummary;
    }
  | {
      kind: 'resume';
      schedule: TemplateScheduleSummary;
    };
type Mutate = (command: TemplateCommand) => Promise<boolean>;
type PagedState = {
  status: string;
  error: string;
  nextCursor: string | null;
  loaded: boolean;
  loadMore: () => Promise<void>;
  reload: () => Promise<void>;
};
function PageState({
  resource,
  empty,
  children,
}: {
  resource: PagedState;
  empty?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      {resource.status === 'error' && (
        <p className="templates__error" role="alert">
          {resource.error}{' '}
          <button type="button" onClick={() => void resource.reload()}>
            try again
          </button>
        </p>
      )}
      {!resource.loaded && resource.status === 'loading' && (
        <p className="templates__quiet" role="status">
          loading…
        </p>
      )}
      {resource.loaded && empty && <div className="templates__empty">{children}</div>}
      {resource.nextCursor && (
        <button
          className="templates__more"
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
function useDirty(dirty: boolean, onDirtyChange?: (dirty: boolean) => void) {
  const callback = useRef(onDirtyChange);
  callback.current = onDirtyChange;
  useEffect(() => {
    callback.current?.(dirty);
    return () => callback.current?.(false);
  }, [dirty]);
}
function ServerRecovery() {
  const connection = useServerConnection(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  if (connection === 'reachable') return null;
  return (
    <p className="templates__banner">
      {connection === 'incompatible'
        ? 'reload lanes before making another change.'
        : 'the server connection is paused. this draft stays here.'}
      <button
        type="button"
        className="templates__text"
        disabled={busy}
        onClick={() => {
          if (connection === 'incompatible') window.location.reload();
          else {
            setBusy(true);
            setError('');
            void checkServerConnection()
              .catch((caught) => setError(errorMessage(caught)))
              .finally(() => setBusy(false));
          }
        }}
      >
        {connection === 'incompatible' ? 'reload lanes' : busy ? 'checking…' : 'check connection'}
      </button>
      {error && <span>{error}</span>}
    </p>
  );
}
function CloseGuard({
  dirty,
  busy,
  onClose,
  children,
  title = 'discard this draft?',
  message = 'the changes in this editor have not been saved.',
  discardLabel = 'discard draft',
}: {
  dirty: boolean;
  busy: boolean;
  onClose: () => void;
  children: (close: () => void) => ReactNode;
  title?: string | undefined;
  message?: string | undefined;
  discardLabel?: string | undefined;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      {children(() => {
        if (!busy) {
          if (dirty) setConfirm(true);
          else onClose();
        }
      })}
      {confirm && (
        <Dialog title={title} onClose={() => setConfirm(false)}>
          <div className="dialog__body">
            <p>{message}</p>
            <footer>
              <button type="button" onClick={() => setConfirm(false)}>
                keep editing
              </button>
              <button type="button" className="primary" onClick={onClose}>
                {discardLabel}
              </button>
            </footer>
          </div>
        </Dialog>
      )}
    </>
  );
}
/** The account key also scopes drafts, abortable reads, and retained command identities. */
export function TemplateWorkspace(props: TemplateWorkspaceProps) {
  return <TemplateWorkspaceBody key={props.account.id} {...props} />;
}
function TemplateWorkspaceBody({
  account,
  clockOffset,
  version = 0,
  onChanged,
  onOpenOperation,
  onRefreshInventory,
  onDirtyChange,
}: TemplateWorkspaceProps) {
  const [tab, setTab] = useState<Tab>('personal'),
    [modal, setModal] = useState<Modal | null>(null),
    [generation, setGeneration] = useState(0),
    [notice, setNotice] = useState('');
  const base = baseFor(account.id),
    invalidation = version + generation;
  const changed = () => {
    setGeneration((value) => value + 1);
    onChanged?.();
  };
  const commands = useCommands(account.id, clockOffset, changed);
  const connection = useServerConnection();
  const commandIdentity = useRef<InputIdentity | null>(null);
  const list = usePagedResource(
    `${account.id}:list-templates`,
    (cursor, signal) =>
      request(`${base}/templates/list${query(cursor)}`, ListPageSchema, { signal }),
    (item) => item.id,
    invalidation,
  );
  const board = usePagedResource(
    `${account.id}:board-templates`,
    (cursor, signal) =>
      request(`${base}/templates/board${query(cursor)}`, BoardTemplatePageSchema, { signal }),
    (item) => item.id,
    invalidation,
  );
  const schedules = usePagedResource(
    tab === 'schedules' ? `${account.id}:template-schedules` : null,
    (cursor, signal) =>
      request(`${base}/template-schedules${query(cursor)}`, SchedulePageSchema, { signal }),
    (item) => item.id,
    invalidation,
  );
  const runs = usePagedResource(
    tab === 'runs' ? `${account.id}:template-runs` : null,
    (cursor, signal) => request(`${base}/template-runs${query(cursor)}`, RunPageSchema, { signal }),
    (item) => item.id,
    invalidation,
  );
  const boards = usePagedResource(
    `${account.id}:template-boards`,
    (cursor, signal) => request(`${base}/boards${query(cursor)}`, BoardPageSchema, { signal }),
    (item) => item.id,
    invalidation,
  );
  const templates: PersonalTemplate[] = [...list.items, ...board.items].filter(
    (item) => item.accountId === account.id,
  );
  const mutate: Mutate = async (command) => {
    const parsed = TemplateCommandSchema.safeParse(command);
    if (!parsed.success) {
      setNotice(parsed.error.issues[0]?.message ?? 'check these fields.');
      return false;
    }
    commandIdentity.current = unchangedInputIdentity(commandIdentity.current, parsed.data, () =>
      newOperationId(clockOffset),
    );
    const result = await commands.submit(parsed.data, 'local', commandIdentity.current.id);
    // A confirmed success ends this intent; a later identical create is new work.
    if (result?.state === 'succeeded') commandIdentity.current = null;
    return result?.state === 'succeeded';
  };
  const close = () => {
    setModal(null);
    commands.clearError();
    setNotice('');
  };
  return (
    <section className="templates" aria-label="templates">
      <header className="templates__heading">
        <div>
          <span className="templates__eyebrow">a place to begin again</span>
          <h2>templates</h2>
          <p>save the shape of your work. start with a fresh copy.</p>
        </div>
        <button
          className="templates__primary"
          type="button"
          disabled={!localWritable(account)}
          onClick={() => setModal({ kind: 'save' })}
        >
          <Icon name="plus" size={15} />
          save a template
        </button>
      </header>
      <div className="templates__scope">
        <span>{account.email}</span>
        <span>snapshots stay separate from google</span>
      </div>
      <nav className="templates__tabs" aria-label="template views">
        {(['personal', 'gallery', 'schedules', 'runs'] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={tab === value}
            onClick={() => {
              setTab(value);
              commands.clearError();
            }}
          >
            {value === 'gallery' ? 'starters' : value}
          </button>
        ))}
      </nav>
      {connection !== 'reachable' && (
        <p className="templates__banner">
          {connection === 'incompatible'
            ? 'reload lanes before making another change.'
            : 'the server connection is paused. unsent drafts stay here.'}
          <button
            type="button"
            className="templates__text"
            onClick={() => {
              if (connection === 'incompatible') window.location.reload();
              else void checkServerConnection().catch((caught) => setNotice(errorMessage(caught)));
            }}
          >
            {connection === 'incompatible' ? 'reload' : 'check connection'}
          </button>
        </p>
      )}
      {!providerWritable(account) && (
        <p className="templates__banner">
          {localWritable(account)
            ? 'your saved templates are available. reconnect this account before creating work in google.'
            : 'this account is read only while it is disconnected.'}
        </p>
      )}
      {(notice || commands.error) && (
        <p className="templates__error" role="alert">
          {notice || commands.error}
          {commands.errorDetails?.operationId && onOpenOperation && (
            <button
              type="button"
              onClick={() => onOpenOperation(commands.errorDetails!.operationId!)}
            >
              inspect operation
            </button>
          )}
        </p>
      )}
      {tab === 'personal' && (
        <>
          <div className="templates__collection">
            {templates.map((template) => (
              <article className="templates__card" key={`${template.kind}:${template.id}`}>
                <div className="templates__card-heading">
                  <span className="templates__stamp">
                    <Icon name={template.kind === 'board' ? 'board' : 'list'} size={16} />
                    {template.kind}
                  </span>
                  <span className="templates__version">v{template.contentRevision}</span>
                </div>
                <button
                  className="templates__name"
                  type="button"
                  onClick={() => setModal({ kind: 'manage', template })}
                >
                  {template.name}
                </button>
                {template.description && <p>{template.description}</p>}
                <div className="templates__card-meta">
                  {template.snapshot.listCount}{' '}
                  {template.snapshot.listCount === 1 ? 'list' : 'lists'}
                  <span>·</span>
                  {template.snapshot.taskCount} tasks<span>·</span>
                  {template.snapshot.dateMode === 'relative' ? 'relative dates' : 'no dates'}
                </div>
                <footer>
                  <button
                    type="button"
                    disabled={!providerWritable(account)}
                    onClick={() => setModal({ kind: 'apply', template })}
                  >
                    use template
                    <Icon name="arrow" size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label={`manage ${template.name}`}
                    onClick={() => setModal({ kind: 'manage', template })}
                  >
                    <Icon name="more" size={17} />
                  </button>
                </footer>
              </article>
            ))}
          </div>
          <PageState resource={list} empty={list.loaded && board.loaded && !templates.length}>
            <Icon name="template" size={23} />
            <h3>keep a good starting point</h3>
            <p>save a list or a whole board, or make a personal copy of a starter.</p>
          </PageState>
          <PageState resource={board} />
        </>
      )}
      {tab === 'gallery' && (
        <GalleryView
          account={account}
          mutate={mutate}
          busy={commands.busy}
          onSaved={() => {
            setTab('personal');
            setNotice('starter saved as an independent personal template.');
          }}
        />
      )}
      {tab === 'schedules' && (
        <>
          <div className="templates__section-heading">
            <p>new lists on a weekly or monthly rhythm.</p>
            <button
              type="button"
              disabled={!localWritable(account) || !templates.length}
              onClick={() => setModal({ kind: 'schedule' })}
            >
              <Icon name="plus" size={14} />
              new schedule
            </button>
          </div>
          <div className="templates__rows">
            {schedules.items
              .filter((item) => item.accountId === account.id)
              .map((schedule) => (
                <article className="templates__row" key={schedule.id}>
                  <div>
                    <span className="templates__stamp">
                      <Icon name="clock" size={14} />
                      {schedule.state}
                    </span>
                    <h3>
                      {templates.find(
                        (template) =>
                          template.id === schedule.template.id &&
                          template.kind === schedule.template.kind,
                      )?.name ?? 'saved template'}{' '}
                      <small>v{schedule.template.contentRevision}</small>
                    </h3>
                    <p>
                      {schedule.timing.frequency === 'weekly'
                        ? `every ${weekdayName(schedule.timing.weekday)}`
                        : `monthly on day ${schedule.timing.dayOfMonth}`}{' '}
                      · {schedule.timing.zone} ·{' '}
                      {boards.items.find((item) => item.id === schedule.boardId)?.title ??
                        'saved destination'}
                    </p>
                    <p>
                      {schedule.nextRunAt
                        ? `next eligible run ${formatInstant(schedule.nextRunAt, schedule.timing.zone)}`
                        : 'no eligible run while paused'}
                      {schedule.pauseReason
                        ? ` · ${schedule.pauseReason.replaceAll('_', ' ')}`
                        : ''}
                    </p>
                    {schedule.catchUpRequired && (
                      <p className="templates__warning">
                        catch-up needs your choice. older missed checklists will be skipped.
                      </p>
                    )}
                  </div>
                  <div className="templates__row-actions">
                    <button
                      type="button"
                      disabled={!localWritable(account) || commands.busy}
                      onClick={() => setModal({ kind: 'schedule', schedule })}
                    >
                      edit
                    </button>
                    {schedule.state === 'active' ? (
                      <button
                        type="button"
                        disabled={!localWritable(account) || commands.busy}
                        onClick={() =>
                          void mutate({
                            kind: 'template.schedule.pause',
                            scheduleId: schedule.id,
                            revision: schedule.revision,
                          })
                        }
                      >
                        pause
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={!localWritable(account) || commands.busy}
                        onClick={() => setModal({ kind: 'resume', schedule })}
                      >
                        resume
                      </button>
                    )}
                    {schedule.activeRunId && (
                      <button
                        type="button"
                        onClick={() => {
                          setTab('runs');
                          setNotice(
                            `resolve the retained run ${schedule.activeRunId} before changing its destination.`,
                          );
                        }}
                      >
                        active run
                      </button>
                    )}
                  </div>
                </article>
              ))}
          </div>
          <PageState resource={schedules} empty={!schedules.items.length}>
            <h3>a rhythm, with room to pause</h3>
            <p>
              schedule a personal template. each run creates new lists and leaves the previous
              checklist intact.
            </p>
          </PageState>
        </>
      )}
      {tab === 'runs' && (
        <>
          <div className="templates__section-heading">
            <p>confirmed work stays put, even when a run pauses.</p>
            <button type="button" onClick={() => void runs.reload()}>
              <Icon name="sync" size={13} />
              refresh
            </button>
          </div>
          <div className="templates__rows">
            {runs.items
              .filter((item) => item.accountId === account.id)
              .map((run) => (
                <article className="templates__row" key={run.id}>
                  <div>
                    <span
                      className={`templates__stamp${run.state === 'partial' || run.state === 'paused' ? ' templates__warning' : ''}`}
                    >
                      {run.state}
                    </span>
                    <h3>
                      {run.scheduleId ? 'scheduled checklist' : 'template copy'}
                      <small>{run.slotDay}</small>
                    </h3>
                    <p>
                      {run.errorCode
                        ? run.errorCode.replaceAll('_', ' ')
                        : run.state === 'succeeded'
                          ? 'all captured work is confirmed.'
                          : 'the captured snapshot stays fixed for this run.'}
                      {run.skippedBefore
                        ? ` · older slots through ${run.skippedBefore} skipped`
                        : ''}
                    </p>
                  </div>
                  <button type="button" onClick={() => setModal({ kind: 'run', run })}>
                    inspect
                    <Icon name="right" size={13} />
                  </button>
                </article>
              ))}
          </div>
          <PageState resource={runs} empty={!runs.items.length}>
            <h3>no copies yet</h3>
            <p>use a template and its progress will appear here.</p>
          </PageState>
        </>
      )}
      {modal?.kind === 'save' && (
        <SourceEditor
          account={account}
          boards={boards}
          template={modal.template}
          mutate={mutate}
          busy={commands.busy}
          error={commands.error}
          onClose={close}
          onSaved={close}
          onDirtyChange={onDirtyChange}
        />
      )}
      {modal?.kind === 'manage' && (
        <TemplateManager
          account={account}
          template={modal.template}
          mutate={mutate}
          busy={commands.busy}
          error={commands.error}
          onClose={close}
          onApplied={(template) => setModal({ kind: 'apply', template })}
          onReplace={(template) => setModal({ kind: 'save', template })}
          onSchedule={(template) => setModal({ kind: 'schedule', template })}
          onDirtyChange={onDirtyChange}
        />
      )}
      {modal?.kind === 'apply' && (
        <ApplyEditor
          account={account}
          template={modal.template}
          boards={boards}
          clockOffset={clockOffset}
          onClose={close}
          onRun={(run) => {
            changed();
            setModal({ kind: 'run', run });
          }}
          onOpenOperation={onOpenOperation}
          onRefreshInventory={onRefreshInventory}
          onDirtyChange={onDirtyChange}
        />
      )}
      {modal?.kind === 'schedule' && (
        <ScheduleEditor
          account={account}
          templates={templates}
          template={modal.template}
          schedule={modal.schedule}
          moreTemplates={Boolean(list.nextCursor || board.nextCursor)}
          onMoreTemplates={() => {
            if (list.nextCursor) void list.loadMore();
            if (board.nextCursor) void board.loadMore();
          }}
          boards={boards}
          mutate={mutate}
          busy={commands.busy}
          error={commands.error}
          onClose={close}
          onSaved={close}
          onDirtyChange={onDirtyChange}
        />
      )}
      {modal?.kind === 'resume' && (
        <ResumeSchedule
          account={account}
          schedule={modal.schedule}
          mutate={mutate}
          busy={commands.busy}
          error={commands.error}
          onClose={close}
          onSaved={close}
        />
      )}
      {modal?.kind === 'run' && (
        <RunDetail
          account={account}
          run={modal.run}
          onClose={close}
          onChanged={changed}
          onOpenOperation={onOpenOperation}
        />
      )}
    </section>
  );
}
function weekdayName(day: number) {
  return (
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'][day - 1] ??
    'weekday'
  );
}
function formatInstant(value: string, zone: string) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: zone,
  }).format(new Date(value));
}
type BoardsResource = ReturnType<typeof usePagedResource<Board>>;
function useLifetime() {
  const controller = useRef(new AbortController());
  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current.abort();
  }, []);
  return controller;
}
function BoardChoice({
  resource,
  value,
  onChange,
  disabled = false,
  label = 'board',
}: {
  resource: BoardsResource;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div>
      <label>
        {label}
        <Select
          value={value}
          onChange={(selectedValue) => onChange(selectedValue)}
          disabled={disabled}
          aria-label={label}
          options={[
            { value: '', label: 'choose a board' },
            ...(value && !resource.items.some((item) => item.id === value)
              ? [{ value: value, label: 'saved board · not loaded' }]
              : []),
            ...resource.items.map((board) => ({
              value: board.id,
              label: `${board.title}${board.isMain ? ' · main' : ''}`,
            })),
          ]}
        />
      </label>
      <PageState resource={resource} />
    </div>
  );
}
function SourceCounts({
  value,
  previous,
}: {
  value: SourcePreview | SnapshotSummary;
  previous?: SnapshotSummary | undefined;
}) {
  return (
    <div className="templates__preview" aria-label="snapshot preview">
      <div className="templates__numbers">
        <span>
          <strong>{value.listCount}</strong>lists
          {previous && <small>previously {previous.listCount}</small>}
        </span>
        <span>
          <strong>{value.taskCount}</strong>tasks
          {previous && <small>previously {previous.taskCount}</small>}
        </span>
        <span>
          <strong>{value.dateMode === 'relative' ? 'relative' : 'none'}</strong>dates
          {previous && (
            <small>previously {previous.dateMode === 'relative' ? 'relative' : 'none'}</small>
          )}
        </span>
      </div>
      <p>
        saved against {value.saveDay} · {value.zone}. all tasks start open when copied.
      </p>
      {value.contextParentCount > 0 && (
        <p>
          {value.contextParentCount} completed parents are included as context for open subtasks.
        </p>
      )}
      {value.completedIncludedCount > 0 && (
        <p>{value.completedIncludedCount} completed tasks are included and will start open.</p>
      )}
      {value.omittedDependencyCount > 0 && (
        <p className="templates__warning">
          {value.omittedDependencyCount} dependencies outside the captured content will be omitted.
        </p>
      )}
      {value.dateMode === 'none' && (
        <p>
          {value.sourceDatedCount} dates, {value.sourceTimedCount} times and{' '}
          {value.sourceRepeatCount} repeat rules will be omitted.
        </p>
      )}
      {value.dateMode === 'relative' && (
        <p>
          relative dates can fall before the application day. times retain their saved zones; repeat
          presets start independent series.
        </p>
      )}
    </div>
  );
}
function SourceEditor({
  account,
  boards,
  template,
  mutate,
  busy,
  error,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  account: ConnectionSummary;
  boards: BoardsResource;
  template?: PersonalTemplate | undefined;
  mutate: Mutate;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSaved: () => void;
  onDirtyChange: TemplateWorkspaceProps['onDirtyChange'];
}) {
  const [kind, setKind] = useState<Kind>(template?.kind ?? 'list'),
    [boardId, setBoardId] = useState(''),
    [listId, setListId] = useState('');
  const [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [completed, setCompleted] = useState(false),
    [dateMode, setDateMode] = useState<'relative' | 'none'>('relative');
  const [preview, setPreview] = useState<{
      fingerprint: string;
      value: SourcePreview;
    } | null>(null),
    [loading, setLoading] = useState(false),
    [formError, setFormError] = useState(''),
    [revision, setRevision] = useState(template?.revision ?? 0);
  const lifetime = useLifetime(),
    base = baseFor(account.id);
  const selectedBoard = boards.items.find((item) => item.id === boardId);
  const lists = usePagedResource(
    boardId && kind === 'list' ? `${account.id}:source:${boardId}` : null,
    (cursor, signal) =>
      request(
        `${base}/boards/${encodeURIComponent(boardId)}/lists${query(cursor)}`,
        BoardListPageSchema,
        { signal },
      ),
    (item) => item.id,
  );
  const selectedList = lists.items.find((item) => item.id === listId);
  const source =
    kind === 'list'
      ? {
          listId,
          listRevision: selectedList?.revision ?? -1,
          includeCompleted: completed,
          dateMode,
        }
      : {
          boardId,
          boardRevision: selectedBoard?.revision ?? -1,
          includeCompleted: completed,
          dateMode,
        };
  const fingerprint = JSON.stringify({ kind, source });
  const currentPreview = preview?.fingerprint === fingerprint ? preview.value : null;
  const dirty = Boolean(name || description || boardId || completed || dateMode !== 'relative');
  useDirty(dirty, onDirtyChange);
  async function previewSource() {
    const parsed = (
      kind === 'list' ? ListTemplateSourceSchema : BoardTemplateSourceSchema
    ).safeParse(source);
    if (!parsed.success) {
      setFormError('choose a loaded source with its current revision.');
      return;
    }
    setLoading(true);
    setFormError('');
    try {
      const value = await request(`${base}/templates/${kind}/source-preview`, SourcePreviewSchema, {
        method: 'POST',
        body: { input: parsed.data },
        signal: lifetime.current.signal,
      });
      if (!lifetime.current.signal.aborted) setPreview({ fingerprint, value });
    } catch (caught) {
      if (!lifetime.current.signal.aborted) setFormError(errorMessage(caught));
    } finally {
      if (!lifetime.current.signal.aborted) setLoading(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!currentPreview || !localWritable(account)) return;
    const command = template
      ? { kind: `template.${kind}.replace`, templateId: template.id, revision, input: source }
      : { kind: `template.${kind}.create`, input: { ...source, name, description } };
    const parsed = TemplateCommandSchema.safeParse(command);
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'check the template fields.');
      return;
    }
    if (await mutate(parsed.data)) onSaved();
  }
  async function reviewRevision() {
    if (!template) return;
    setLoading(true);
    try {
      const latest = await request<PersonalTemplate>(
        `${base}/templates/${template.kind}/${encodeURIComponent(template.id)}`,
        template.kind === 'list' ? ListTemplateSummarySchema : BoardTemplateSummarySchema,
        { signal: lifetime.current.signal },
      );
      setRevision(latest.revision);
      setPreview(null);
      setFormError(
        'latest template revision loaded. your source choice stays here; preview the replacement again.',
      );
    } catch (caught) {
      if (!lifetime.current.signal.aborted) setFormError(errorMessage(caught));
    } finally {
      if (!lifetime.current.signal.aborted) setLoading(false);
    }
  }
  return (
    <CloseGuard dirty={dirty} busy={busy || loading} onClose={onClose}>
      {(close) => (
        <Dialog
          title={template ? `replace ${template.name}` : 'save a starting point'}
          onClose={close}
          wide
          pending={busy || loading}
        >
          <form className="dialog__body templates__form" onSubmit={(event) => void submit(event)}>
            <ServerRecovery />
            <p>
              {template
                ? 'the new snapshot becomes a new content version. already admitted runs keep their original input.'
                : 'choose a source, then review what will be saved. later edits to the source will not change this snapshot.'}
            </p>
            <fieldset disabled={busy || loading || !localWritable(account)}>
              {!template && (
                <div className="templates__segmented" aria-label="template kind">
                  {(['list', 'board'] as const).map((value) => (
                    <button
                      type="button"
                      key={value}
                      aria-pressed={kind === value}
                      onClick={() => {
                        setKind(value);
                        setListId('');
                      }}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              )}
              <BoardChoice
                resource={boards}
                value={boardId}
                onChange={(value) => {
                  setBoardId(value);
                  setListId('');
                }}
                label="source board"
              />
              {kind === 'list' && (
                <>
                  <label>
                    source list
                    <Select
                      value={listId}
                      onChange={(selectedValue) => setListId(selectedValue)}
                      disabled={!boardId}
                      aria-label="source list"
                      options={[
                        { value: '', label: 'choose a list' },
                        ...lists.items
                          .filter((item) => item.accountId === account.id)
                          .map((item) => ({ value: item.id, label: item.title })),
                      ]}
                    />
                  </label>
                  {boardId && <PageState resource={lists} />}
                </>
              )}
              {!template && (
                <>
                  <label>
                    name
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={256}
                      required
                    />
                  </label>
                  <label>
                    description
                    <textarea
                      rows={2}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      maxLength={4000}
                    />
                  </label>
                </>
              )}
              <label>
                dates
                <Select
                  value={dateMode}
                  onChange={(selectedValue) => setDateMode(selectedValue as 'relative' | 'none')}
                  aria-label="dates"
                  options={[
                    { value: 'relative', label: 'relative to the application day' },
                    { value: 'none', label: 'no dates, times or active repeat rules' },
                  ]}
                />
              </label>
              <label className="templates__check">
                <input
                  type="checkbox"
                  checked={completed}
                  onChange={(event) => setCompleted(event.target.checked)}
                />
                include completed tasks · copies still start open
              </label>
              <button
                className="templates__secondary"
                type="button"
                onClick={() => void previewSource()}
              >
                {loading ? 'reading source…' : 'preview snapshot'}
              </button>
            </fieldset>
            {currentPreview && (
              <SourceCounts value={currentPreview} previous={template?.snapshot} />
            )}
            {(formError || error) && (
              <p className="templates__error" role="alert">
                {formError || error}
              </p>
            )}
            {template && error && (
              <button
                className="templates__text"
                type="button"
                disabled={loading || busy}
                onClick={() => void reviewRevision()}
              >
                review latest template revision
              </button>
            )}
            <footer>
              <button type="button" onClick={close} disabled={busy || loading}>
                cancel
              </button>
              <button
                className="primary"
                type="submit"
                disabled={busy || loading || !currentPreview || !localWritable(account)}
              >
                {busy ? 'saving…' : template ? 'confirm replacement' : 'save template'}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </CloseGuard>
  );
}
function SnapshotContent({
  accountId,
  snapshotId,
  applicationDay,
  relative = true,
}: {
  accountId: string;
  snapshotId: string;
  applicationDay: string;
  relative?: boolean;
}) {
  const base = `${baseFor(accountId)}/templates/snapshots/${encodeURIComponent(snapshotId)}`;
  const lists = usePagedResource(
    `${accountId}:${snapshotId}:lists`,
    (cursor, signal) =>
      request(`${base}/lists${query(cursor, 10)}`, page(TemplateListSchema), { signal }),
    (item) => item.key,
  );
  const tasks = usePagedResource(
    `${accountId}:${snapshotId}:tasks`,
    (cursor, signal) =>
      request(`${base}/tasks${query(cursor, 10)}`, page(TemplateTaskSchema), { signal }),
    (item) => item.key,
  );
  return (
    <div className="templates__snapshot">
      <div className="templates__snapshot-lists">
        {lists.items.map((list) => (
          <span key={list.key}>
            <i style={{ background: list.color }} />
            {list.title}
          </span>
        ))}
      </div>
      <PageState resource={lists} />
      <ol>
        {tasks.items.map((task) => (
          <li key={task.key} className={task.parentKey ? 'templates__child' : ''}>
            <div>
              <span className="templates__task-check" />
              {task.title || '(untitled task)'}
              {task.starred && <Icon name="star" size={12} />}
            </div>
            <small>
              {lists.items.find((list) => list.key === task.listKey)?.title ?? task.listKey} ·{' '}
              {templateTaskDate(task, applicationDay, relative)}
              {task.repeatPreset && relative ? ` · repeats ${task.repeatPreset.frequency}` : ''}
              {task.priority !== 'none' ? ` · ${task.priority} priority` : ''}
              {task.dependencyKeys.length
                ? ` · ${task.dependencyKeys.length} internal dependencies`
                : ''}
            </small>
            {task.labels.length > 0 && (
              <span className="templates__task-labels">
                {task.labels.map((label) => (
                  <span key={label.name}>
                    <i style={{ background: label.color }} />
                    {label.name}
                  </span>
                ))}
              </span>
            )}
            {task.notes && (
              <details>
                <summary>notes</summary>
                <p className="templates__notes">{task.notes}</p>
              </details>
            )}
          </li>
        ))}
      </ol>
      <PageState resource={tasks} empty={!tasks.items.length}>
        <p>this snapshot has no tasks.</p>
      </PageState>
      <p className="templates__quiet">
        {tasks.items.length} tasks loaded{tasks.nextCursor ? ' · more in this snapshot' : ''}. every
        copied task starts open.
      </p>
    </div>
  );
}
function TemplateManager({
  account,
  template,
  mutate,
  busy,
  error,
  onClose,
  onApplied,
  onReplace,
  onSchedule,
  onDirtyChange,
}: {
  account: ConnectionSummary;
  template: PersonalTemplate;
  mutate: Mutate;
  busy: boolean;
  error: string;
  onClose: () => void;
  onApplied: (template: PersonalTemplate) => void;
  onReplace: (template: PersonalTemplate) => void;
  onSchedule: (template: PersonalTemplate) => void;
  onDirtyChange: TemplateWorkspaceProps['onDirtyChange'];
}) {
  const [baseline, setBaseline] = useState(template),
    [name, setName] = useState(template.name),
    [description, setDescription] = useState(template.description),
    [deleteConfirm, setDeleteConfirm] = useState(false),
    [formError, setFormError] = useState('');
  const lifetime = useLifetime(),
    dirty = name !== baseline.name || description !== baseline.description;
  useDirty(dirty, onDirtyChange);
  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = TemplateCommandSchema.safeParse({
      kind: `template.${baseline.kind}.update`,
      templateId: baseline.id,
      revision: baseline.revision,
      input: { name, description },
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'check the template fields.');
      return;
    }
    if (await mutate(parsed.data)) onClose();
  }
  async function remove() {
    if (
      await mutate(
        TemplateCommandSchema.parse({
          kind: `template.${baseline.kind}.delete`,
          templateId: baseline.id,
          revision: baseline.revision,
        }),
      )
    )
      onClose();
  }
  async function reviewLatest() {
    try {
      const next = await request<PersonalTemplate>(
        `${baseFor(account.id)}/templates/${baseline.kind}/${encodeURIComponent(baseline.id)}`,
        baseline.kind === 'list' ? ListTemplateSummarySchema : BoardTemplateSummarySchema,
        { signal: lifetime.current.signal },
      );
      setBaseline(next);
      setFormError(
        'latest revision loaded. your name and description draft is retained; compare it before saving.',
      );
    } catch (caught) {
      if (!lifetime.current.signal.aborted) setFormError(errorMessage(caught));
    }
  }
  return (
    <CloseGuard dirty={dirty} busy={busy} onClose={onClose}>
      {(close) => (
        <Dialog title={baseline.name} onClose={close} wide pending={busy}>
          <div className="dialog__body templates__form">
            <ServerRecovery />
            <span className="templates__stamp">
              {baseline.kind} template · content v{baseline.contentRevision}
            </span>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                try {
                  void save(event);
                } catch (caught) {
                  setFormError(errorMessage(caught));
                }
              }}
            >
              <fieldset disabled={busy || !localWritable(account)}>
                <label>
                  name
                  <input value={name} onChange={(event) => setName(event.target.value)} required />
                </label>
                <label>
                  description
                  <textarea
                    rows={2}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </label>
              </fieldset>
              {dirty && (
                <footer>
                  <button
                    type="button"
                    onClick={() => {
                      setName(baseline.name);
                      setDescription(baseline.description);
                    }}
                  >
                    reset fields
                  </button>
                  <button
                    type="submit"
                    className="primary"
                    disabled={busy || !localWritable(account)}
                  >
                    save details
                  </button>
                </footer>
              )}
            </form>
            <SourceCounts value={baseline.snapshot} />
            <details className="templates__disclosure">
              <summary>look inside this snapshot</summary>
              <SnapshotContent
                accountId={account.id}
                snapshotId={baseline.snapshot.id}
                applicationDay={accountToday(account.planningZone)}
              />
            </details>
            {(formError || error) && (
              <p className="templates__error" role="alert">
                {formError || error}
              </p>
            )}
            {error && (
              <button
                className="templates__text"
                type="button"
                onClick={() => void reviewLatest()}
                disabled={busy}
              >
                review latest revision without discarding fields
              </button>
            )}
            <div className="templates__management">
              <button
                type="button"
                disabled={dirty || busy || !providerWritable(account)}
                onClick={() => onApplied(baseline)}
              >
                use template
                <Icon name="arrow" size={14} />
              </button>
              <button
                type="button"
                disabled={dirty || busy || !localWritable(account)}
                onClick={() => onSchedule(baseline)}
              >
                schedule a checklist
                <Icon name="clock" size={14} />
              </button>
              <button
                type="button"
                disabled={dirty || busy || !localWritable(account)}
                onClick={() => onReplace(baseline)}
              >
                replace the saved snapshot
                <Icon name="sync" size={14} />
              </button>
            </div>
            <details className="templates__disclosure">
              <summary>delete template</summary>
              <p>its schedules will pause. existing lists, tasks and captured runs stay intact.</p>
              <label className="templates__check">
                <input
                  type="checkbox"
                  checked={deleteConfirm}
                  onChange={(event) => setDeleteConfirm(event.target.checked)}
                />
                delete this reusable template
              </label>
              <button
                className="templates__danger"
                type="button"
                disabled={!deleteConfirm || busy || !localWritable(account)}
                onClick={() => void remove()}
              >
                delete template
              </button>
            </details>
          </div>
        </Dialog>
      )}
    </CloseGuard>
  );
}
function ApplyEditor({
  account,
  template,
  boards,
  clockOffset,
  onClose,
  onRun,
  onOpenOperation,
  onRefreshInventory,
  onDirtyChange,
}: {
  account: ConnectionSummary;
  template: PersonalTemplate;
  boards: BoardsResource;
  clockOffset: number;
  onClose: () => void;
  onRun: (run: TemplateRunSummary) => void;
  onOpenOperation: TemplateWorkspaceProps['onOpenOperation'];
  onRefreshInventory: TemplateWorkspaceProps['onRefreshInventory'];
  onDirtyChange: TemplateWorkspaceProps['onDirtyChange'];
}) {
  const today = accountToday(
    account.planningZone,
    new Date(Date.now() + clockOffset).toISOString(),
  );
  const [boardId, setBoardId] = useState(''),
    [newBoard, setNewBoard] = useState(false),
    [title, setTitle] = useState(template.name),
    [day, setDay] = useState(today),
    [relative, setRelative] = useState(template.snapshot.dateMode === 'relative'),
    [prefix, setPrefix] = useState('');
  const [preview, setPreview] = useState<{
      fingerprint: string;
      value: z.infer<typeof ApplicationPreviewSchema>;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [acknowledged, setAcknowledged] = useState(false);
  const [inspectedRun, setInspectedRun] = useState<TemplateRunSummary | null>(null);
  const [attempt, setAttempt] = useState<{
    id: string;
    input: z.infer<typeof ApplyTemplateSchema>;
  } | null>(null);
  const lifetime = useLifetime(),
    identity = useRef<InputIdentity | null>(null),
    base = baseFor(account.id);
  const connection = useServerConnection();
  const selectedBoard = boards.items.find((item) => item.id === boardId);
  const settings = { applicationDay: day, useRelativeDates: relative, listPrefix: prefix };
  const input = {
    ...settings,
    template: ref(template),
    destination: newBoard
      ? { kind: 'new', title }
      : { kind: 'existing', boardId, boardRevision: selectedBoard?.revision ?? -1 },
    confirmed: true,
  };
  const fingerprint = JSON.stringify(input),
    currentPreview = preview?.fingerprint === fingerprint ? preview.value : null;
  useEffect(() => setAcknowledged(false), [fingerprint]);
  const previousRuns = usePagedResource(
    `${account.id}:previous-template-runs:${template.snapshot.id}`,
    (cursor, signal) => request(`${base}/template-runs${query(cursor)}`, RunPageSchema, { signal }),
    (item) => item.id,
  );
  const sameRuns = previousRuns.items.filter(
    (run) => run.accountId === account.id && run.snapshotId === template.snapshot.id,
  );
  const conflicts = usePagedResource(
    currentPreview && currentPreview.preview.labelColorConflictCount > 0
      ? `${account.id}:${template.snapshot.id}:color-conflicts`
      : null,
    (cursor, signal) =>
      request(`${base}/templates/label-conflicts`, ConflictPageSchema, {
        method: 'POST',
        body: { template: ref(template), limit: 50, ...(cursor ? { cursor } : {}) },
        signal,
      }),
    (item) => item.name,
  );
  const dirty = Boolean(boardId || newBoard || day !== today || prefix || attempt);
  useDirty(dirty, onDirtyChange);
  async function previewApplication() {
    const parsed = TemplateApplicationOptionsSchema.safeParse(settings);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'check the application day.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const value = await request(
        `${base}/templates/application-preview`,
        ApplicationPreviewSchema,
        {
          method: 'POST',
          body: { template: ref(template), options: parsed.data },
          signal: lifetime.current.signal,
        },
      );
      if (!lifetime.current.signal.aborted) {
        setPreview({ fingerprint, value });
        setAcknowledged(false);
      }
    } catch (caught) {
      if (!lifetime.current.signal.aborted) setError(errorMessage(caught));
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  async function begin(event: FormEvent) {
    event.preventDefault();
    if (!providerWritable(account) || busy || connection !== 'reachable') return;
    const parsed = ApplyTemplateSchema.safeParse(attempt?.input ?? input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'choose a current destination.');
      return;
    }
    if (
      !attempt &&
      (!currentPreview ||
        applicationCapacityMessage(
          currentPreview.preview.requiredListSlots,
          currentPreview.capacity,
        ) ||
        !acknowledged)
    )
      return;
    identity.current = unchangedInputIdentity(identity.current, parsed.data, () =>
      newOperationId(clockOffset),
    );
    const captured = attempt ?? { id: identity.current.id, input: parsed.data };
    setAttempt(captured);
    setBusy(true);
    setError('');
    try {
      const run = await request(`${base}/template-runs`, TemplateRunSummarySchema, {
        method: 'POST',
        body: { operationId: captured.id, input: captured.input },
        signal: lifetime.current.signal,
      });
      if (!lifetime.current.signal.aborted && run.accountId === account.id) onRun(run);
    } catch (caught) {
      if (!lifetime.current.signal.aborted)
        setError(
          `${errorMessage(caught)} the same captured input and operation identity are retained for retry. inspect that operation before starting another copy.`,
        );
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  const capacityMessage = currentPreview
    ? applicationCapacityMessage(currentPreview.preview.requiredListSlots, currentPreview.capacity)
    : '';
  return (
    <>
      <CloseGuard
        dirty={dirty}
        busy={busy}
        onClose={onClose}
        title={attempt ? 'leave this copy?' : undefined}
        discardLabel={attempt ? 'leave editor' : undefined}
        message={
          attempt
            ? 'the server may already have saved this copy. closing this editor does not cancel it. inspect the retained operation before making another copy.'
            : undefined
        }
      >
        {(close) => (
          <Dialog title={`use ${template.name}`} onClose={close} wide pending={busy}>
            <form className="dialog__body templates__form" onSubmit={(event) => void begin(event)}>
              <ServerRecovery />
              <p>
                content v{template.contentRevision} · this creates new lists and open tasks.
                matching names stay separate.
              </p>
              <fieldset disabled={busy || Boolean(attempt) || !providerWritable(account)}>
                {template.kind === 'board' && (
                  <label>
                    destination
                    <Select
                      value={newBoard ? 'new' : 'existing'}
                      onChange={(selectedValue) => {
                        setNewBoard(selectedValue === 'new');
                        setAcknowledged(false);
                      }}
                      aria-label="destination"
                      options={[
                        { value: 'existing', label: 'add lists to an existing board' },
                        { value: 'new', label: 'create a new board' },
                      ]}
                    />
                  </label>
                )}
                {newBoard ? (
                  <label>
                    new board name
                    <input
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      required
                    />
                  </label>
                ) : (
                  <BoardChoice
                    resource={boards}
                    value={boardId}
                    onChange={setBoardId}
                    label="destination board"
                  />
                )}
                <div className="templates__two-fields">
                  <label>
                    application day
                    <input
                      type="date"
                      value={day}
                      onChange={(event) => setDay(event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    list-name prefix <small>optional</small>
                    <input
                      value={prefix}
                      onChange={(event) => setPrefix(event.target.value)}
                      placeholder="e.g. november"
                    />
                  </label>
                </div>
                <label className="templates__check">
                  <input
                    type="checkbox"
                    checked={relative}
                    onChange={(event) => setRelative(event.target.checked)}
                    disabled={template.snapshot.dateMode === 'none'}
                  />
                  use relative dates, saved times and repeat presets
                </label>
                {template.snapshot.dateMode === 'none' && (
                  <p>this snapshot was saved without dates. there are no dates to restore.</p>
                )}
                <button
                  type="button"
                  className="templates__secondary"
                  onClick={() => void previewApplication()}
                >
                  preview this copy
                </button>
              </fieldset>
              {currentPreview && (
                <div className="templates__preview">
                  <div className="templates__numbers">
                    <span>
                      <strong>{currentPreview.preview.listCount}</strong>new lists
                    </span>
                    <span>
                      <strong>{currentPreview.preview.taskCount}</strong>open tasks
                    </span>
                    <span>
                      <strong>{currentPreview.capacity.available ?? 'unknown'}</strong>list slots
                      available
                    </span>
                  </div>
                  <p>
                    {currentPreview.preview.requiredListSlots} slots required ·{' '}
                    {currentPreview.capacity.known ?? 'unknown'} existing lists ·{' '}
                    {currentPreview.capacity.reserved} slots reserved · account limit 2,000.
                  </p>
                  {capacityMessage && (
                    <p className="templates__warning">
                      {capacityMessage}
                      {onRefreshInventory && (
                        <button
                          type="button"
                          className="templates__text"
                          onClick={onRefreshInventory}
                        >
                          refresh inventory
                        </button>
                      )}
                      <button
                        type="button"
                        className="templates__text"
                        disabled={busy || Boolean(attempt)}
                        onClick={() => void previewApplication()}
                      >
                        check capacity again
                      </button>
                    </p>
                  )}
                  {currentPreview.preview.negativeDateCount > 0 && (
                    <p className="templates__warning">
                      {currentPreview.preview.negativeDateCount} tasks will be dated before {day}.
                      those dates are kept as shown.
                    </p>
                  )}
                  <p>
                    {currentPreview.preview.omittedDates} dates,{' '}
                    {currentPreview.preview.omittedTimes} times,{' '}
                    {currentPreview.preview.omittedRepeatRules} repeat rules and{' '}
                    {currentPreview.preview.omittedDependencyCount} external dependencies omitted.
                  </p>
                  <p>
                    {currentPreview.preview.labelDefinitionCount} saved label definitions. matching
                    names reuse your account labels; their existing colors are kept.
                  </p>
                  {currentPreview.preview.labelColorConflictCount > 0 && (
                    <details>
                      <summary>
                        {currentPreview.preview.labelColorConflictCount} label color differences
                      </summary>
                      <ul className="templates__conflicts">
                        {conflicts.items.map((item) => (
                          <li key={item.name}>
                            {item.name}
                            <span>
                              <i style={{ background: item.requestedColor }} />
                              saved {item.requestedColor}
                              <Icon name="right" size={11} />
                              <i style={{ background: item.keptColor }} />
                              keep {item.keptColor}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <PageState resource={conflicts} />
                    </details>
                  )}
                </div>
              )}
              <details className="templates__disclosure">
                <summary>preview tasks and resulting dates</summary>
                <SnapshotContent
                  accountId={account.id}
                  snapshotId={template.snapshot.id}
                  applicationDay={day || today}
                  relative={relative}
                />
              </details>
              <details className="templates__disclosure">
                <summary>
                  previous copies of this snapshot
                  {sameRuns.length ? ` · ${sameRuns.length} loaded` : ''}
                </summary>
                {sameRuns.map((run) => (
                  <p key={run.id}>
                    {run.slotDay} · {run.state}{' '}
                    <button
                      type="button"
                      className="templates__text"
                      onClick={() => setInspectedRun(run)}
                    >
                      inspect retained output
                    </button>
                  </p>
                ))}
                {previousRuns.loaded && !sameRuns.length && (
                  <p>
                    no matching copy in the loaded run history.
                    {previousRuns.nextCursor ? ' more history is available.' : ''}
                  </p>
                )}
                <PageState resource={previousRuns} />
                <p>
                  a new copy does not resume or clean up earlier work. inspect partial or uncertain
                  runs before making another copy.
                </p>
              </details>
              {sameRuns.some((run) => !['succeeded', 'cancelled'].includes(run.state)) && (
                <p className="templates__warning templates__prior-output">
                  this snapshot already has retained unfinished output.{' '}
                  <button
                    className="templates__text"
                    type="button"
                    onClick={() =>
                      setInspectedRun(
                        sameRuns.find((run) => !['succeeded', 'cancelled'].includes(run.state))!,
                      )
                    }
                  >
                    inspect the existing run before creating another copy
                  </button>
                </p>
              )}
              {currentPreview && !attempt && (
                <label className="templates__check">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  create a separate new copy with the counts and dates above; previous output stays
                  intact
                </label>
              )}
              {error && (
                <p className="templates__error" role="alert">
                  {error}
                </p>
              )}
              {attempt && (
                <p className="templates__retained">
                  captured operation <code>{attempt.id}</code>
                  {onOpenOperation && (
                    <button
                      type="button"
                      className="templates__text"
                      onClick={() => onOpenOperation(attempt.id)}
                    >
                      inspect operation
                    </button>
                  )}
                </p>
              )}
              <footer>
                <button type="button" disabled={busy} onClick={close}>
                  close
                </button>
                <button
                  className="primary"
                  type="submit"
                  disabled={
                    busy ||
                    connection !== 'reachable' ||
                    !providerWritable(account) ||
                    (!attempt && (!currentPreview || Boolean(capacityMessage) || !acknowledged))
                  }
                >
                  {busy ? 'admitting copy…' : attempt ? 'retry captured copy' : 'create fresh copy'}
                </button>
              </footer>
            </form>
          </Dialog>
        )}
      </CloseGuard>
      {inspectedRun && (
        <RunDetail
          account={account}
          run={inspectedRun}
          onClose={() => setInspectedRun(null)}
          onChanged={() => void previousRuns.reload()}
          onOpenOperation={onOpenOperation}
        />
      )}
    </>
  );
}
function GalleryView({
  account,
  mutate,
  busy,
  onSaved,
}: {
  account: ConnectionSummary;
  mutate: Mutate;
  busy: boolean;
  onSaved: () => void;
}) {
  const [data, setData] = useState<
      {
        kind: Kind;
        entries: Gallery;
      }[]
    >([]),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void Promise.all(
      (['list', 'board'] as const).map(async (kind) => ({
        kind,
        entries: (
          await request(`${baseFor(account.id)}/templates/gallery?kind=${kind}`, GallerySchema, {
            signal: controller.signal,
          })
        ).items,
      })),
    )
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(errorMessage(caught));
      });
    return () => controller.abort();
  }, [account.id, reload]);
  return (
    <>
      <p className="templates__intro">a few small starting points. save one to make it yours.</p>
      {error && (
        <p className="templates__error" role="alert">
          {error}
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            try again
          </button>
        </p>
      )}
      {!data.length && !error && <p className="templates__quiet">loading starters…</p>}
      <div className="templates__collection">
        {data.flatMap((group) =>
          group.entries.map((entry) => (
            <article className="templates__card" key={`${group.kind}:${entry.id}`}>
              <span className="templates__stamp">
                <Icon name={group.kind === 'board' ? 'board' : 'list'} size={15} />
                {group.kind} starter
              </span>
              <h3>{entry.name}</h3>
              <p>{entry.description}</p>
              <div className="templates__card-meta">
                {entry.document.header.listCount} lists<span>·</span>
                {entry.document.header.taskCount} tasks
              </div>
              <details className="templates__starter-preview">
                <summary>look inside</summary>
                {entry.document.lists.map((item) => (
                  <p key={item.key}>
                    <strong>{item.title}</strong>
                  </p>
                ))}
                <ul>
                  {entry.document.tasks.map((task) => (
                    <li key={task.key}>
                      {task.parentKey ? '↳ ' : ''}
                      {task.title}
                    </li>
                  ))}
                </ul>
              </details>
              <footer>
                <button
                  type="button"
                  disabled={busy || !localWritable(account)}
                  onClick={() => {
                    void mutate(
                      TemplateCommandSchema.parse({
                        kind: `template.${group.kind}.gallery`,
                        galleryId: entry.id,
                      }),
                    ).then((saved) => {
                      if (saved) onSaved();
                    });
                  }}
                >
                  save personal copy
                  <Icon name="plus" size={13} />
                </button>
              </footer>
            </article>
          )),
        )}
      </div>
    </>
  );
}
function ScheduleEditor({
  account,
  templates,
  template,
  schedule,
  boards,
  mutate,
  busy,
  error,
  onClose,
  onSaved,
  onDirtyChange,
  moreTemplates,
  onMoreTemplates,
}: {
  account: ConnectionSummary;
  templates: PersonalTemplate[];
  template?: PersonalTemplate | undefined;
  schedule?: TemplateScheduleSummary | undefined;
  boards: BoardsResource;
  mutate: Mutate;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSaved: () => void;
  onDirtyChange: TemplateWorkspaceProps['onDirtyChange'];
  moreTemplates: boolean;
  onMoreTemplates: () => void;
}) {
  const initialRef =
    schedule?.template ?? (template ? ref(template) : templates[0] ? ref(templates[0]) : null);
  const [selection, setSelection] = useState(
      initialRef ? `${initialRef.kind}:${initialRef.id}:${initialRef.contentRevision}` : '',
    ),
    [boardId, setBoardId] = useState(schedule?.boardId ?? ''),
    [frequency, setFrequency] = useState<'weekly' | 'monthly'>(
      schedule?.timing.frequency ?? 'weekly',
    );
  const [weekday, setWeekday] = useState(
      schedule?.timing.frequency === 'weekly' ? schedule.timing.weekday : 1,
    ),
    [monthDay, setMonthDay] = useState(
      schedule?.timing.frequency === 'monthly' ? schedule.timing.dayOfMonth : 1,
    ),
    [zone, setZone] = useState(schedule?.timing.zone ?? account.planningZone),
    [startsOn, setStartsOn] = useState(
      schedule?.timing.startsOn ?? accountToday(account.planningZone),
    ),
    [prefix, setPrefix] = useState(schedule?.listPrefix ?? ''),
    [relative, setRelative] = useState(
      schedule?.useRelativeDates ?? template?.snapshot.dateMode !== 'none',
    );
  const [baseline, setBaseline] = useState(schedule),
    [formError, setFormError] = useState(''),
    [deleteConfirm, setDeleteConfirm] = useState(false),
    [reviewing, setReviewing] = useState(false);
  const lifetime = useLifetime(),
    selected = templates.find(
      (item) => `${item.kind}:${item.id}:${item.contentRevision}` === selection,
    );
  const selectedRef = selected
    ? ref(selected)
    : initialRef &&
        selection === `${initialRef.kind}:${initialRef.id}:${initialRef.contentRevision}`
      ? initialRef
      : null;
  const selectedBoard = boards.items.find((item) => item.id === boardId);
  const timingInput =
    frequency === 'weekly'
      ? { frequency, weekday, zone, startsOn }
      : { frequency, dayOfMonth: monthDay, zone, startsOn };
  const timing = TemplateScheduleSchema.safeParse(timingInput);
  let nextDay = '';
  if (timing.success) {
    const today = accountToday(timing.data.zone);
    nextDay =
      latestTemplateSlot(timing.data, {
        notAfter: today,
        ...(baseline?.lastResolvedDay ? { after: baseline.lastResolvedDay } : {}),
      }) ?? nextTemplateSlot(timing.data, { after: today });
  }
  const settings = {
    selection,
    boardId,
    frequency,
    weekday,
    monthDay,
    zone,
    startsOn,
    prefix,
    relative,
  };
  const original = useRef(JSON.stringify(settings));
  const dirty = JSON.stringify(settings) !== original.current;
  useDirty(dirty, onDirtyChange);
  async function save(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    const parsed = CreateTemplateScheduleSchema.safeParse({
      template: selectedRef,
      boardId,
      boardRevision: selectedBoard?.revision ?? -1,
      timing: timingInput,
      useRelativeDates: relative && selected?.snapshot.dateMode !== 'none',
      listPrefix: prefix,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? 'choose a loaded template and board.');
      return;
    }
    const command: TemplateCommand = baseline
      ? {
          kind: 'template.schedule.update',
          scheduleId: baseline.id,
          revision: baseline.revision,
          input: parsed.data,
        }
      : { kind: 'template.schedule.create', input: parsed.data };
    if (await mutate(command)) onSaved();
  }
  async function reviewLatest() {
    if (!baseline) return;
    setReviewing(true);
    try {
      const latest = await request(
        `${baseFor(account.id)}/template-schedules/${encodeURIComponent(baseline.id)}`,
        TemplateScheduleSummarySchema,
        { signal: lifetime.current.signal },
      );
      setBaseline(latest);
      setFormError(
        `latest schedule revision ${latest.revision} loaded. your draft stays here; changes affect future unclaimed slots.`,
      );
    } catch (caught) {
      if (!lifetime.current.signal.aborted) setFormError(errorMessage(caught));
    } finally {
      if (!lifetime.current.signal.aborted) setReviewing(false);
    }
  }
  return (
    <CloseGuard dirty={dirty} busy={busy || reviewing} onClose={onClose}>
      {(close) => (
        <Dialog
          title={baseline ? 'edit recurring checklist' : 'a recurring checklist'}
          onClose={close}
          wide
          pending={busy || reviewing}
        >
          <form className="dialog__body templates__form" onSubmit={(event) => void save(event)}>
            <ServerRecovery />
            <p>
              each run adds new lists to the chosen board. it never resets a previous checklist.
            </p>
            {baseline?.activeRunId && (
              <p className="templates__banner">
                a captured run is still attached. its original snapshot and destination stay fixed.
                resolve or cancel that run before changing the future destination.
              </p>
            )}
            <fieldset disabled={busy || reviewing || !localWritable(account)}>
              <label>
                personal template
                <Select
                  value={selection}
                  onChange={(selectedValue) => setSelection(selectedValue)}
                  required
                  aria-label="personal template"
                  options={[
                    { value: '', label: 'choose a template' },
                    ...(initialRef &&
                    !templates.some(
                      (item) => `${item.kind}:${item.id}:${item.contentRevision}` === selection,
                    )
                      ? [
                          {
                            value: `${initialRef.kind}:${initialRef.id}:${initialRef.contentRevision}`,
                            label: `saved ${initialRef.kind} template · v${initialRef.contentRevision}`,
                          },
                        ]
                      : []),
                    ...templates.map((item) => ({
                      value: `${item.kind}:${item.id}:${item.contentRevision}`,
                      label: `${item.name} · ${item.kind} · v${item.contentRevision}`,
                    })),
                  ]}
                />
              </label>
              {moreTemplates && (
                <button type="button" className="templates__text" onClick={onMoreTemplates}>
                  load more personal templates
                </button>
              )}
              <BoardChoice
                resource={boards}
                value={boardId}
                onChange={setBoardId}
                label="destination board"
                disabled={Boolean(baseline?.activeRunId)}
              />
              <div className="templates__two-fields">
                <label>
                  frequency
                  <Select
                    value={frequency}
                    onChange={(selectedValue) =>
                      setFrequency(selectedValue as 'weekly' | 'monthly')
                    }
                    aria-label="frequency"
                    options={[
                      { value: 'weekly', label: 'weekly' },
                      { value: 'monthly', label: 'monthly' },
                    ]}
                  />
                </label>
                {frequency === 'weekly' ? (
                  <label>
                    weekday
                    <Select
                      value={String(weekday)}
                      onChange={(selectedValue) => setWeekday(Number(selectedValue))}
                      aria-label="weekday"
                      options={[
                        ...[1, 2, 3, 4, 5, 6, 7].map((day) => ({
                          value: String(day),
                          label: weekdayName(day),
                        })),
                      ]}
                    />
                  </label>
                ) : (
                  <label>
                    day of month
                    <Select
                      value={String(monthDay)}
                      onChange={(selectedValue) => setMonthDay(Number(selectedValue))}
                      aria-label="day of month"
                      options={[
                        ...Array.from({ length: 28 }, (_, index) => index + 1).map((day) => ({
                          value: String(day),
                          label: String(day),
                        })),
                      ]}
                    />
                  </label>
                )}
              </div>
              <div className="templates__two-fields">
                <label>
                  starts on
                  <input
                    type="date"
                    value={startsOn}
                    onChange={(event) => setStartsOn(event.target.value)}
                    required
                  />
                </label>
                <label>
                  time zone
                  <TimeZoneSelect value={zone} onChange={setZone} aria-label="schedule time zone" />
                </label>
              </div>
              <p>
                this schedule keeps its own zone. changing your account zone later will not move it.
              </p>
              <label>
                list-name prefix <small>optional</small>
                <input value={prefix} onChange={(event) => setPrefix(event.target.value)} />
              </label>
              <label className="templates__check">
                <input
                  type="checkbox"
                  checked={relative && selected?.snapshot.dateMode !== 'none'}
                  onChange={(event) => setRelative(event.target.checked)}
                  disabled={selected?.snapshot.dateMode === 'none'}
                />
                use relative dates from the scheduled local day
              </label>
            </fieldset>
            {nextDay && (
              <div className="templates__preview">
                <p>
                  {baseline?.state === 'paused'
                    ? 'when resumed, the latest eligible checklist is'
                    : 'next eligible checklist date'}{' '}
                  <strong>{nextDay}</strong> · {zone}.
                </p>
                <p>
                  lanes aims to start within the hour after local midnight while google
                  authorization and free-plan capacity are available.
                </p>
              </div>
            )}
            {!providerWritable(account) && (
              <p>
                this definition can be saved locally. execution stays paused until reconnect and an
                explicit catch-up choice.
              </p>
            )}
            {(formError || error) && (
              <p className="templates__error" role="alert">
                {formError || error}
              </p>
            )}
            {baseline && error && (
              <button
                className="templates__text"
                type="button"
                onClick={() => void reviewLatest()}
                disabled={busy || reviewing}
              >
                review latest revision; keep my draft
              </button>
            )}
            <footer>
              <button type="button" onClick={close} disabled={busy || reviewing}>
                cancel
              </button>
              <button
                type="submit"
                className="primary"
                disabled={
                  busy ||
                  reviewing ||
                  !localWritable(account) ||
                  !timing.success ||
                  !selectedRef ||
                  !selectedBoard
                }
              >
                {busy ? 'saving…' : 'save schedule'}
              </button>
            </footer>
            {baseline && (
              <details className="templates__disclosure">
                <summary>delete schedule</summary>
                <p>
                  future checklists stop. already admitted runs and their confirmed output remain.
                </p>
                <label className="templates__check">
                  <input
                    type="checkbox"
                    checked={deleteConfirm}
                    onChange={(event) => setDeleteConfirm(event.target.checked)}
                  />
                  delete this schedule
                </label>
                <button
                  className="templates__danger"
                  type="button"
                  disabled={!deleteConfirm || busy || !localWritable(account)}
                  onClick={() => {
                    void mutate({
                      kind: 'template.schedule.delete',
                      scheduleId: baseline.id,
                      revision: baseline.revision,
                    }).then((saved) => {
                      if (saved) onSaved();
                    });
                  }}
                >
                  delete schedule
                </button>
              </details>
            )}
          </form>
        </Dialog>
      )}
    </CloseGuard>
  );
}
function ResumeSchedule({
  account,
  schedule,
  mutate,
  busy,
  error,
  onClose,
  onSaved,
}: {
  account: ConnectionSummary;
  schedule: TemplateScheduleSummary;
  mutate: Mutate;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [choice, setChoice] = useState<'latest' | 'skip'>('latest');
  const today = accountToday(schedule.timing.zone),
    latest = latestTemplateSlot(schedule.timing, {
      notAfter: today,
      ...(schedule.lastResolvedDay ? { after: schedule.lastResolvedDay } : {}),
    });
  const older = latest
    ? latestTemplateSlot(schedule.timing, {
        notAfter: addCalendarDays(latest, -1),
        ...(schedule.lastResolvedDay ? { after: schedule.lastResolvedDay } : {}),
      })
    : null;
  return (
    <Dialog title="resume this rhythm" onClose={onClose} pending={busy}>
      <div className="dialog__body templates__form">
        <ServerRecovery />
        <p>choose what to do with the missed checklists. lanes will not generate a backlog.</p>
        <label className="templates__check">
          <input
            type="radio"
            name="catch-up"
            checked={choice === 'latest'}
            onChange={() => setChoice('latest')}
          />
          {latest
            ? `create only the latest eligible checklist · ${latest}`
            : 'resume with the next eligible checklist'}
        </label>
        <label className="templates__check">
          <input
            type="radio"
            name="catch-up"
            checked={choice === 'skip'}
            onChange={() => setChoice('skip')}
          />
          skip catch-up and wait for the next new slot
        </label>
        <div className="templates__preview">
          <p>
            {choice === 'skip' && latest
              ? `missed slots through ${latest} will be marked skipped.`
              : older
                ? `older missed slots through ${older} will be marked skipped.`
                : 'there is no older eligible slot to skip.'}{' '}
            zone: {schedule.timing.zone}.
          </p>
        </div>
        {schedule.activeRunId && (
          <p className="templates__warning">
            a retained run is attached. resolve or cancel it first; resuming this schedule cannot
            move it to another slot.
          </p>
        )}
        {!providerWritable(account) && <p>reconnect this account before resuming.</p>}
        {error && (
          <p className="templates__error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !providerWritable(account)}
            onClick={() => {
              void mutate({
                kind: 'template.schedule.resume',
                scheduleId: schedule.id,
                revision: schedule.revision,
                catchUp: choice,
              }).then((saved) => {
                if (saved) onSaved();
              });
            }}
          >
            resume schedule
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
function RunDetail({
  account,
  run: initial,
  onClose,
  onChanged,
  onOpenOperation,
}: {
  account: ConnectionSummary;
  run: TemplateRunSummary;
  onClose: () => void;
  onChanged: () => void;
  onOpenOperation: TemplateWorkspaceProps['onOpenOperation'];
}) {
  const [run, setRun] = useState(initial),
    [operation, setOperation] = useState<OperationSummary | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [cancel, setCancel] = useState(false);
  const [running, setRunning] = useState(
    initial.state === 'capturing' || initial.state === 'running',
  );
  const connection = useServerConnection();
  const lifetime = useLifetime(),
    base = baseFor(account.id),
    refreshVersion = useRef(0);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  async function refresh(signal: AbortSignal) {
    const generation = ++refreshVersion.current;
    const [latest, receipt] = await Promise.all([
      request(`${base}/template-runs/${encodeURIComponent(initial.id)}`, TemplateRunSummarySchema, {
        signal,
      }),
      request(
        `${base}/operations/${encodeURIComponent(initial.operationId)}`,
        OperationSummarySchema,
        { signal },
      ).catch((caught) => {
        if (caught instanceof RequestError && caught.code === 'not_found') return null;
        throw caught;
      }),
    ]);
    if (!signal.aborted && generation === refreshVersion.current) {
      setRun(latest);
      setOperation(receipt);
    }
    return { run: latest, operation: receipt };
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((caught) => {
      if (!controller.signal.aborted) setError(errorMessage(caught));
    });
    return () => controller.abort();
  }, [initial.id]);
  async function action(kind: 'advance' | 'resume' | 'cancel') {
    if (busy || running || connection !== 'reachable') return;
    setBusy(true);
    setError('');
    try {
      const value = await request(
        `${base}/template-runs/${encodeURIComponent(run.id)}/${kind}`,
        TemplateRunSummarySchema,
        { method: 'POST', body: {}, signal: lifetime.current.signal },
      );
      if (!lifetime.current.signal.aborted) {
        setRun(value);
        changed.current();
        await refresh(lifetime.current.signal);
        setCancel(false);
        if (kind !== 'cancel' && ['capturing', 'running'].includes(value.state)) setRunning(true);
      }
    } catch (caught) {
      if (!lifetime.current.signal.aborted) {
        setError(
          `${errorMessage(caught)} confirmed output is retained. refresh this run before trying another copy.`,
        );
        void refresh(lifetime.current.signal).catch(() => {});
      }
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  // Foreground progress is bounded and sequential. The run owner, rather than this
  // loop, decides whether a captured step may be dispatched or reconciled.
  useEffect(() => {
    if (!running) return;
    if (!providerWritable(account) || connection !== 'reachable') {
      setRunning(false);
      return;
    }
    const controller = new AbortController(),
      deadline = Date.now() + 30000;
    async function continueCaptured() {
      try {
        let current = await refresh(controller.signal);
        while (
          !controller.signal.aborted &&
          Date.now() < deadline &&
          ['capturing', 'running'].includes(current.run.state) &&
          !current.operation?.finished &&
          !['uncertain', 'reconnect_required', 'blocked_by_limit', 'failed', 'cancelled'].includes(
            current.operation?.state ?? '',
          ) &&
          (!current.operation?.nextAttemptAt || current.operation.nextAttemptAt < Date.now() + 2000)
        ) {
          const delay = Math.max(600, (current.operation?.nextAttemptAt ?? 0) - Date.now());
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(done, delay);
            function done() {
              controller.signal.removeEventListener('abort', abort);
              resolve();
            }
            function abort() {
              clearTimeout(timer);
              reject(new DOMException('aborted', 'AbortError'));
            }
            controller.signal.addEventListener('abort', abort, { once: true });
          });
          if (controller.signal.aborted || Date.now() >= deadline) break;
          await request(
            `${base}/template-runs/${encodeURIComponent(initial.id)}/advance`,
            TemplateRunSummarySchema,
            { method: 'POST', body: {}, signal: controller.signal },
          );
          changed.current();
          current = await refresh(controller.signal);
        }
      } catch (caught) {
        if (!controller.signal.aborted)
          setError(`${errorMessage(caught)} inspect confirmed progress before continuing.`);
      } finally {
        if (!controller.signal.aborted) setRunning(false);
      }
    }
    void continueCaptured();
    return () => controller.abort();
  }, [running, initial.id, account.state, connection]);
  // Read-only polling keeps cron progress visible after the short foreground run.
  useEffect(() => {
    if (running || ['succeeded', 'cancelled', 'paused', 'partial'].includes(run.state)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void refresh(controller.signal).catch((caught) => {
        if (!controller.signal.aborted) setError(errorMessage(caught));
      });
    }, 2500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [run, running]);
  const terminal = run.state === 'succeeded' || run.state === 'cancelled';
  return (
    <Dialog title="template run" onClose={onClose} wide pending={busy}>
      <div className="dialog__body templates__form">
        <ServerRecovery />
        <span className="templates__stamp">
          {run.scheduleId ? 'scheduled' : 'manual'} · {run.slotDay} · {run.state}
        </span>
        <div className="templates__preview">
          <div className="templates__numbers">
            <span>
              <strong>{operation?.confirmedSteps ?? '—'}</strong>confirmed steps
            </span>
            <span>
              <strong>{operation?.totalSteps ?? '—'}</strong>total steps
            </span>
            <span>
              <strong>{operation?.inputSealed ? 'ready' : 'saving'}</strong>input
            </span>
          </div>
          <p>
            progress includes preparing the copy, creating lists and tasks, and linking
            dependencies. steps are counted separately from tasks.
          </p>
        </div>
        {operation && (
          <progress
            aria-label="confirmed operation steps"
            value={operation.confirmedSteps}
            max={operation.totalSteps}
          />
        )}
        <p>
          this run keeps the original snapshot and destination. confirmed lists and tasks stay in
          your workspace; no automatic rollback removes them.
        </p>
        {run.skippedBefore && (
          <p>older missed checklist slots through {run.skippedBefore} were skipped.</p>
        )}
        {(run.errorCode || operation?.error) && (
          <p className="templates__warning">
            {operation?.error?.message ?? run.errorCode?.replaceAll('_', ' ')}
          </p>
        )}
        {operation?.state === 'uncertain' && (
          <p className="templates__warning">
            google may have accepted the last creation. inspect and reconcile the operation before
            continuing; a new copy can create duplicates.
          </p>
        )}
        {operation?.nextAttemptAt && (
          <p>
            next retry opportunity{' '}
            {new Intl.DateTimeFormat('en', {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: account.planningZone,
            }).format(operation.nextAttemptAt)}{' '}
            · {account.planningZone}.
          </p>
        )}
        {error && (
          <p className="templates__error" role="alert">
            {error}
          </p>
        )}
        <p className="templates__retained">
          operation <code>{run.operationId}</code>
        </p>
        <div className="templates__management">
          {running && (
            <button type="button" onClick={() => setRunning(false)}>
              leave progress in the background
              <Icon name="clock" size={14} />
            </button>
          )}
          <button
            type="button"
            disabled={busy || running}
            onClick={() => {
              setError('');
              void refresh(lifetime.current.signal).catch((caught) =>
                setError(errorMessage(caught)),
              );
            }}
          >
            <Icon name="sync" size={14} />
            refresh confirmed progress
          </button>
          {onOpenOperation && (
            <button type="button" disabled={busy} onClick={() => onOpenOperation(run.operationId)}>
              inspect operation
              <Icon name="external" size={14} />
            </button>
          )}
          {!terminal &&
            !operation?.finished &&
            (run.state === 'paused' || run.state === 'partial') && (
              <button
                type="button"
                disabled={
                  busy ||
                  running ||
                  connection !== 'reachable' ||
                  !providerWritable(account) ||
                  operation?.state === 'uncertain'
                }
                onClick={() => void action('resume')}
              >
                resume this captured run
                <Icon name="arrow" size={14} />
              </button>
            )}
          {!terminal &&
            !operation?.finished &&
            (run.state === 'capturing' || run.state === 'running') && (
              <button
                type="button"
                disabled={
                  busy ||
                  running ||
                  connection !== 'reachable' ||
                  !providerWritable(account) ||
                  operation?.state === 'uncertain'
                }
                onClick={() => void action('advance')}
              >
                {run.state === 'capturing' ? 'continue capturing input' : 'continue saved work'}
                <Icon name="arrow" size={14} />
              </button>
            )}
        </div>
        {!terminal && (
          <details className="templates__disclosure">
            <summary>stop unsent work</summary>
            <p>
              cancel stops unissued steps. already dispatched work must settle, and confirmed output
              remains. this cannot undo a copy.
            </p>
            <label className="templates__check">
              <input
                type="checkbox"
                checked={cancel}
                onChange={(event) => setCancel(event.target.checked)}
              />
              keep existing output and cancel remaining work
            </label>
            <button
              className="templates__danger"
              type="button"
              disabled={
                busy || running || connection !== 'reachable' || !cancel || !localWritable(account)
              }
              onClick={() => void action('cancel')}
            >
              cancel remaining work
            </button>
          </details>
        )}
      </div>
    </Dialog>
  );
}
