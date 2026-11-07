import { useRef, useState, type FormEvent } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { Board } from '../../contracts/board';
import { BoardTemplateSummarySchema } from '../../contracts/template';
import {
  BoardTemplateSourceSchema,
  ListTemplateSourceSchema,
  TemplateCommandSchema,
  type TemplateCommand,
} from '../../contracts/template-commands';
import {
  ListTemplateSummarySchema,
  TemplateListSchema,
  TemplateTaskSchema,
  type SnapshotSummary,
} from '../../../tasks/contracts/template';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { request } from '../../../../shared/browser/http/http';
import { BoardListPageSchema } from '../../contracts/query';
import { usePagedResource } from '../../../../shared/browser/resources/usePagedResource';
import { Select } from '../../../../shared/ui/select/Select';
import { PageState, ServerRecovery } from './TemplateFeedback';
import { type SourcePreview, SourcePreviewSchema, page } from './template-client';
import {
  type PersonalTemplate,
  type Mutate,
  type Kind,
  baseFor,
  query,
  errorMessage,
  localWritable,
  templateTaskDate,
} from './template-model';
import { type TemplateWorkspaceProps } from './TemplateWorkspace';
import { useLifetime, useDirty, CloseGuard } from './TemplateDraft';

export type BoardsResource = ReturnType<typeof usePagedResource<Board>>;

export function BoardChoice({
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

export function SourceCounts({
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

export function SourceEditor({
  account,
  boards,
  template,
  draft,
  mutate,
  error,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  account: ConnectionSummary;
  boards: BoardsResource;
  template?: PersonalTemplate | undefined;
  draft?: TemplateCommand | undefined;
  mutate: Mutate;
  error: string;
  onClose: () => void;
  onSaved: () => void;
  onDirtyChange: TemplateWorkspaceProps['onDirtyChange'];
}) {
  const retained =
    draft?.kind === 'template.list.create' ||
    draft?.kind === 'template.board.create' ||
    draft?.kind === 'template.list.replace' ||
    draft?.kind === 'template.board.replace'
      ? draft.input
      : null;
  const captured = useRef(false);
  const [kind, setKind] = useState<Kind>(
      draft?.kind.startsWith('template.board.') ? 'board' : (template?.kind ?? 'list'),
    ),
    [boardId, setBoardId] = useState(retained && 'boardId' in retained ? retained.boardId : ''),
    [listId, setListId] = useState(retained && 'listId' in retained ? retained.listId : '');
  const [name, setName] = useState(
      retained && 'name' in retained && typeof retained.name === 'string' ? retained.name : '',
    ),
    [description, setDescription] = useState(
      retained && 'description' in retained && typeof retained.description === 'string'
        ? retained.description
        : '',
    ),
    [completed, setCompleted] = useState(retained?.includeCompleted ?? false),
    [dateMode, setDateMode] = useState<'relative' | 'none'>(retained?.dateMode ?? 'relative');
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
  function submit(event: FormEvent) {
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
    if (!captured.current && mutate(parsed.data)) {
      captured.current = true;
      onSaved();
    }
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
    <CloseGuard dirty={dirty} busy={loading} onClose={onClose}>
      {(close) => (
        <Dialog
          title={template ? `replace ${template.name}` : 'save a starting point'}
          onClose={close}
          wide
          pending={loading}
        >
          <form className="dialog__body templates__form" onSubmit={(event) => void submit(event)}>
            <ServerRecovery />
            <p>
              {template
                ? 'the new snapshot becomes a new content version. already admitted runs keep their original input.'
                : 'choose a source, then review what will be saved. later edits to the source will not change this snapshot.'}
            </p>
            <fieldset disabled={loading || !localWritable(account)}>
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
                disabled={loading}
                onClick={() => void reviewRevision()}
              >
                review latest template revision
              </button>
            )}
            <footer>
              <button type="button" onClick={close} disabled={loading}>
                cancel
              </button>
              <button
                className="primary"
                type="submit"
                disabled={loading || !currentPreview || !localWritable(account)}
              >
                {template ? 'confirm replacement' : 'save template'}
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </CloseGuard>
  );
}

export function SnapshotContent({
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
