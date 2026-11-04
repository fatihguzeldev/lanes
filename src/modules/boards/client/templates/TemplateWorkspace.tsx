import { useRef, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts';
import { type TemplateRunSummary, type TemplateScheduleSummary } from '../../template-contract';
import { TemplateCommandSchema } from '../../template-command-contract';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { checkServerConnection, request } from '../../../../shared/browser/http/http';
import { BoardPageSchema } from '../../query-contract';
import { usePagedResource } from '../../../../shared/browser/resources/usePagedResource';
import { newOperationId } from '../../../operations/browser/submission/operation-identity';
import { useCommands } from '../../../tasks/client/useCommands';
import { useServerConnection } from '../../../../shared/browser/connectivity/useServerConnection';
import './TemplateWorkspace.css';
import {
  type PersonalTemplate,
  type Tab,
  baseFor,
  type InputIdentity,
  query,
  type Mutate,
  unchangedInputIdentity,
  localWritable,
  errorMessage,
  providerWritable,
  weekdayName,
  formatInstant,
} from './template-model';
import {
  ListPageSchema,
  BoardTemplatePageSchema,
  SchedulePageSchema,
  RunPageSchema,
} from './template-client';
import { PageState } from './TemplateFeedback';
import { GalleryView } from './TemplateGallery';
import { SourceEditor } from './TemplateSource';
import { TemplateManager } from './TemplateManager';
import { ApplyEditor } from './TemplateApply';
import { ScheduleEditor, ResumeSchedule } from './TemplateSchedule';
import { RunDetail } from './TemplateRun';

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
