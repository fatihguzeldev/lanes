import { useRef, useState, type FormEvent } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import {
  CreateTemplateScheduleSchema,
  TemplateScheduleSummarySchema,
  type TemplateScheduleSummary,
} from '../../template-contract';
import { type TemplateCommand } from '../../template-command-contract';
import { TemplateScheduleSchema } from '../../../tasks/planning-contract';
import {
  accountToday,
  addCalendarDays,
  latestTemplateSlot,
  nextTemplateSlot,
} from '../../../tasks/planning';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
import { request } from '../../../../shared/browser/http/http';
import { Select } from '../../../../shared/ui/select/Select';
import { TimeZoneSelect } from '../../../../shared/ui/time-zone/TimeZoneSelect';
import {
  type PersonalTemplate,
  type Mutate,
  ref,
  baseFor,
  errorMessage,
  localWritable,
  weekdayName,
  providerWritable,
} from './template-model';
import { type BoardsResource, BoardChoice } from './TemplateSource';
import { type TemplateWorkspaceProps } from './TemplateWorkspace';
import { useLifetime, useDirty, CloseGuard } from './TemplateDraft';
import { ServerRecovery } from './TemplateFeedback';

export function ScheduleEditor({
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

export function ResumeSchedule({
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
