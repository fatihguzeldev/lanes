import { describe, expect, it } from 'vitest';
import { TaskSchema, type Task } from '../contracts';
import {
  createEditorDraft,
  editorDraftIsDirty,
  prepareEditorSubmission,
  rebaseEditorDraft,
  restorePausedRepeatRule,
} from './task-editor-model';

function task(fields: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id: 'task',
    accountId: 'a',
    listId: 'list',
    parentId: null,
    title: 'read',
    notes: 'a\nnote',
    completed: false,
    completedAt: null,
    labelIds: ['label'],
    priority: 'low',
    starred: true,
    blockedBy: ['unknown'],
    revision: 7,
    seriesId: null,
    occurrenceId: null,
    provider: {
      id: 'google-task',
      listId: 'google-list',
      etag: 'v7',
      position: '1',
      updatedAt: null,
    },
    capabilities: {
      canEdit: true,
      canEditNotes: true,
      canMove: true,
      canDelete: true,
      canHaveChildren: true,
      canNest: true,
      assignmentSource: null,
      sourceUrl: null,
      restriction: null,
    },
    unsupportedHierarchy: false,
    ...fields,
  });
}
const base = {
  accountId: 'a',
  listId: 'list',
  timeZone: 'Europe/Istanbul',
  weekStart: 1 as const,
  parentId: null,
};

describe('paused rule recovery', () => {
  const rule = {
    frequency: 'weekly' as const,
    interval: 2,
    anchorDay: '2026-10-01',
    zone: 'America/New_York',
    weekdays: [2, 4],
    weekStart: 7 as const,
    end: { type: 'count' as const, count: 20 },
  };
  it('restores only the selected repeat settings into the existing unsent draft', () => {
    const original = task();
    const draft = createEditorDraft(original, base);
    draft.title = 'my unsent title';
    draft.notes = 'my unsent note';
    draft.scheduledDay = '2026-11-03';
    draft.scheduledTime = '09:30';
    const restored = restorePausedRepeatRule(draft, rule);
    expect(restored).toMatchObject({
      title: 'my unsent title',
      notes: 'my unsent note',
      scheduledDay: '2026-11-03',
      scheduledTime: '09:30',
      repeatEnabled: true,
      repeatFrequency: 'weekly',
      repeatInterval: '2',
      repeatZone: 'America/New_York',
      repeatWeekStart: 7,
      repeatWeekdays: [2, 4],
      repeatEnd: 'count',
      repeatCount: '20',
    });
    expect(prepareEditorSubmission(restored, { ...base, task: original })).toMatchObject({
      ok: true,
      patch: { repeatRule: { ...rule, anchorDay: '2026-11-03' } },
    });
    expect(draft.repeatEnabled).toBe(false);
  });
  it('does not invent a date or silently extend an expired retained end day', () => {
    const draft = createEditorDraft(task(), base);
    const restored = restorePausedRepeatRule(draft, rule);
    expect(restored.scheduledDay).toBe('');
    expect(prepareEditorSubmission(restored, { ...base, task: task() })).toMatchObject({
      ok: false,
      fields: { scheduledDay: expect.any(String) },
    });
    restored.scheduledDay = '2026-11-03';
    restored.repeatEnd = 'date';
    restored.repeatEndDay = '2026-10-31';
    expect(prepareEditorSubmission(restored, { ...base, task: task() })).toMatchObject({
      ok: false,
      fields: { 'repeatRule.end.day': expect.any(String) },
    });
  });
  it('leaves a completed task completed when a new repeat rule is saved', () => {
    const original = task({ completed: true, completedAt: '2026-10-01T12:00:00Z' });
    const draft = restorePausedRepeatRule(createEditorDraft(original, base), rule);
    draft.scheduledDay = '2026-11-03';
    const prepared = prepareEditorSubmission(draft, { ...base, task: original });
    expect(prepared).toMatchObject({
      ok: true,
      kind: 'edit',
      patch: { repeatRule: expect.any(Object) },
    });
    if (prepared.ok && prepared.kind === 'edit') expect('completed' in prepared.patch).toBe(false);
  });
});

describe('task editor drafts', () => {
  it('makes narrow patches and preserves unknown retained references and provider values', () => {
    const original = task();
    const draft = createEditorDraft(original, base);
    expect(editorDraftIsDirty(draft, original, base)).toBe(false);
    draft.starred = false;
    expect(prepareEditorSubmission(draft, { ...base, task: original })).toEqual({
      ok: true,
      kind: 'edit',
      patch: { starred: false },
    });
    expect(draft.blockedBy).toEqual(['unknown']);
  });
  it('keeps empty provider titles editable through local metadata without rewriting them', () => {
    const original = task({ title: '' });
    const draft = createEditorDraft(original, base);
    draft.priority = 'high';
    expect(prepareEditorSubmission(draft, { ...base, task: original })).toEqual({
      ok: true,
      kind: 'edit',
      patch: { priority: 'high' },
    });
  });
  it('does not reset title/notes or silently clear other fields when validation fails', () => {
    const original = task();
    const draft = createEditorDraft(original, base);
    draft.title = '  ';
    draft.notes = 'keep\nmy unsent draft';
    const result = prepareEditorSubmission(draft, { ...base, task: original });
    expect(result).toMatchObject({ ok: false, fields: { title: expect.any(String) } });
    expect(draft.notes).toBe('keep\nmy unsent draft');
  });
  it('clears time and repeat explicitly when the scheduled day is removed', () => {
    const original = task({
      scheduledDay: '2026-11-02',
      scheduledTime: '09:00',
      timeZone: 'Europe/Istanbul',
      repeatRule: {
        frequency: 'daily',
        interval: 1,
        anchorDay: '2026-11-02',
        zone: 'Europe/Istanbul',
        weekdays: [],
        weekStart: 1,
        end: { type: 'never' },
      },
    });
    const draft = createEditorDraft(original, base);
    draft.scheduledDay = '';
    expect(prepareEditorSubmission(draft, { ...base, task: original })).toEqual({
      ok: true,
      kind: 'edit',
      patch: { scheduledDay: null, scheduledTime: null, timeZone: null, repeatRule: null },
    });
  });
  it('keeps day-only values independent from time zones and validates a local time with a named zone', () => {
    const draft = createEditorDraft(null, { ...base, initialDay: '2026-03-08' });
    draft.title = 'day only';
    expect(prepareEditorSubmission(draft, { ...base, task: null })).toMatchObject({
      ok: true,
      kind: 'create',
      input: { scheduledDay: '2026-03-08', scheduledTime: null, timeZone: null },
    });
    draft.scheduledTime = '02:30';
    draft.timeZone = 'America/New_York';
    expect(prepareEditorSubmission(draft, { ...base, task: null })).toMatchObject({
      ok: true,
      input: { scheduledDay: '2026-03-08', scheduledTime: '02:30', timeZone: 'America/New_York' },
    });
    draft.timeZone = '+03:00';
    expect(prepareEditorSubmission(draft, { ...base, task: null })).toMatchObject({
      ok: false,
      fields: { timeZone: expect.any(String) },
    });
  });
  it('preserves the repeat anchor on unrelated edits and reanchors a changed schedule', () => {
    const rule = {
      frequency: 'monthly' as const,
      interval: 1,
      anchorDay: '2026-01-31',
      zone: 'Europe/Istanbul',
      weekdays: [],
      weekStart: 1 as const,
      end: { type: 'never' as const },
    };
    const original = task({ scheduledDay: '2026-02-28', repeatRule: rule });
    const draft = createEditorDraft(original, base);
    draft.priority = 'high';
    expect(prepareEditorSubmission(draft, { ...base, task: original })).toEqual({
      ok: true,
      kind: 'edit',
      patch: { priority: 'high' },
    });
    draft.scheduledDay = '2026-03-15';
    expect(prepareEditorSubmission(draft, { ...base, task: original })).toMatchObject({
      ok: true,
      patch: { scheduledDay: '2026-03-15', repeatRule: { anchorDay: '2026-03-15' } },
    });
  });
  it('validates weekly weekdays, repeat limits and nested task restrictions', () => {
    const draft = createEditorDraft(null, { ...base, initialDay: '2026-11-02' });
    draft.title = 'repeat';
    draft.repeatEnabled = true;
    draft.repeatFrequency = 'weekly';
    draft.repeatWeekdays = [];
    expect(prepareEditorSubmission(draft, { ...base, task: null })).toMatchObject({
      ok: false,
      fields: { 'repeatRule.weekdays': expect.any(String) },
    });
    draft.repeatWeekdays = [1];
    draft.repeatEnd = 'count';
    draft.repeatCount = '10001';
    expect(prepareEditorSubmission(draft, { ...base, task: null })).toMatchObject({
      ok: false,
      fields: { 'repeatRule.end.count': expect.any(String) },
    });
    draft.repeatCount = '5';
    expect(
      prepareEditorSubmission(draft, { ...base, parentId: 'parent', task: null }),
    ).toMatchObject({ ok: false, fields: { repeatRule: expect.any(String) } });
  });
  it('treats label/dependency order as a set and enforces immutable account/list context', () => {
    const original = task({ labelIds: ['a', 'b'], blockedBy: ['one', 'two'] });
    const draft = createEditorDraft(original, base);
    draft.labelIds.reverse();
    draft.blockedBy.reverse();
    expect(editorDraftIsDirty(draft, original, base)).toBe(false);
    expect(
      prepareEditorSubmission(draft, { ...base, task: { ...original, accountId: 'other' } }),
    ).toMatchObject({ ok: false, fields: { accountId: expect.any(String) } });
  });
  it('does not submit native provider fields that an assigned task cannot edit', () => {
    const original = task({
      capabilities: { ...task().capabilities, canEditNotes: false, assignmentSource: 'docs' },
    });
    const draft = createEditorDraft(original, base);
    draft.notes = 'forbidden';
    expect(prepareEditorSubmission(draft, { ...base, task: original })).toMatchObject({
      ok: false,
      fields: { notes: expect.any(String) },
    });
  });
});

it('preserves untouched whitespace titles and refuses repetition without a scheduled day', () => {
  const original = task({ title: '  externally kept  ' });
  const draft = createEditorDraft(original, base);
  draft.starred = false;
  expect(prepareEditorSubmission(draft, { ...base, task: original })).toEqual({
    ok: true,
    kind: 'edit',
    patch: { starred: false },
  });
  const fresh = createEditorDraft(null, base);
  fresh.title = 'task';
  fresh.repeatEnabled = true;
  expect(prepareEditorSubmission(fresh, { ...base, task: null })).toMatchObject({
    ok: false,
    fields: { scheduledDay: expect.any(String) },
  });
});

it('explicitly rebases only edited fields and retains unrelated newer server data', () => {
  const previous = task();
  const latest = task({
    revision: 8,
    title: 'changed elsewhere',
    priority: 'high',
    blockedBy: ['new blocker'],
  });
  const draft = createEditorDraft(previous, base);
  draft.notes = 'my unsent note';
  draft.starred = false;
  const rebased = rebaseEditorDraft(draft, previous, latest, base);
  expect(rebased).toMatchObject({
    title: 'changed elsewhere',
    priority: 'high',
    blockedBy: ['new blocker'],
    notes: 'my unsent note',
    starred: false,
  });
  expect(prepareEditorSubmission(rebased, { ...base, task: latest })).toEqual({
    ok: true,
    kind: 'edit',
    patch: { notes: 'my unsent note', starred: false },
  });
  expect(draft.title).toBe('read');
});

it('refuses to rebase a preserved draft onto another account or moved list', () => {
  const previous = task(),
    draft = createEditorDraft(previous, base);
  draft.notes = 'preserve me';
  expect(() => rebaseEditorDraft(draft, previous, task({ accountId: 'b' }), base)).toThrow();
  expect(() => rebaseEditorDraft(draft, previous, task({ listId: 'elsewhere' }), base)).toThrow();
  expect(draft.notes).toBe('preserve me');
});
