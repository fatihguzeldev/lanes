import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { RecurrenceStatusSchema } from '../recurrence-contract';
import type { RepeatRule } from '../planning-contract';
import { TaskRecurrence } from './TaskRecurrence';

const rule: RepeatRule = {
  frequency: 'daily',
  interval: 1,
  anchorDay: '2026-11-03',
  zone: 'Europe/Istanbul',
  weekStart: 1,
  weekdays: [],
  end: { type: 'never' },
};
const status = RecurrenceStatusSchema.parse({
  taskId: 'task',
  seriesId: 'series',
  occurrenceId: null,
  state: 'paused',
  createdCount: 1,
  successorTaskId: null,
  operationId: 'operation',
  checklistComplete: true,
  nextAttemptAt: null,
  errorCode: null,
});
const props = {
  taskId: 'task',
  completed: false,
  hasRule: true,
  repeatEnabled: true,
  hasDay: true,
  nested: false,
  dirty: false,
  available: true,
  status,
  loading: false,
  error: null,
  pending: false,
  onResume() {},
  onInspect() {},
  onRestore() {},
  onRetry() {},
};
describe('repeat recovery presentation', () => {
  it('offers explicit resume for paused work and prevents resuming against an unsaved draft', () => {
    expect(renderToStaticMarkup(createElement(TaskRecurrence, props))).toContain(
      'resume repeat work',
    );
    const dirty = renderToStaticMarkup(createElement(TaskRecurrence, { ...props, dirty: true }));
    expect(dirty).toContain('save or discard your draft');
    expect(dirty).toMatch(/disabled=""[^>]*>resume repeat work/);
  });
  it('requires date recovery before offering the retained rule, and never restores it during rendering', () => {
    let restored = false;
    const paused = {
      ...status,
      pausedRule: { rule, reason: 'provider_day_removed' as const, pausedAt: 123 },
    };
    const html = renderToStaticMarkup(
      createElement(TaskRecurrence, {
        ...props,
        hasRule: false,
        repeatEnabled: false,
        hasDay: false,
        status: paused,
        onRestore: () => {
          restored = true;
        },
      }),
    );
    expect(html).toContain('google removed the scheduled day');
    expect(html).toMatch(/disabled=""[^>]*>restore this rule to the draft/);
    expect(html).not.toContain('resume repeat work');
    expect(restored).toBe(false);
  });
  it('keeps an externally nested rule paused until the task is promoted', () => {
    const html = renderToStaticMarkup(
      createElement(TaskRecurrence, {
        ...props,
        nested: true,
        hasRule: false,
        repeatEnabled: false,
        status: { ...status, pausedRule: { rule, reason: 'provider_nested_task', pausedAt: 123 } },
      }),
    );
    expect(html).toContain('promote this task');
    expect(html).toMatch(/disabled=""[^>]*>restore this rule to the draft/);
  });
  it('keeps uncertain work inspectable without offering an unsafe resume', () => {
    const html = renderToStaticMarkup(
      createElement(TaskRecurrence, {
        ...props,
        status: { ...status, state: 'uncertain', errorCode: 'outcome_uncertain' },
      }),
    );
    expect(html).toContain('check the last save before continuing repetition');
    expect(html).not.toContain('resume repeat work');
    expect(html).toContain('check repeat progress');
    expect(html).not.toContain('<code>');
  });
  it('explains a newly assigned rule on a historical completed task without inventing a successor', () => {
    const html = renderToStaticMarkup(
      createElement(TaskRecurrence, {
        ...props,
        completed: true,
        status: { ...status, state: 'active', operationId: null },
      }),
    );
    expect(html).toContain('reopen it before a new completion');
    expect(html).not.toContain('successor created');
  });
  it('surfaces failed status reads and rejects another task status', () => {
    expect(
      renderToStaticMarkup(
        createElement(TaskRecurrence, {
          ...props,
          status: null,
          error: 'repeat status unavailable',
        }),
      ),
    ).toContain('repeat status unavailable');
    const html = renderToStaticMarkup(
      createElement(TaskRecurrence, { ...props, status: { ...status, taskId: 'another' } }),
    );
    expect(html).not.toContain('resume repeat work');
  });
  it('does not act on stale status while it refreshes or after its read fails', () => {
    const refreshing = renderToStaticMarkup(
      createElement(TaskRecurrence, { ...props, loading: true }),
    );
    expect(refreshing).toMatch(/disabled=""[^>]*>resume repeat work/);
    const failed = renderToStaticMarkup(
      createElement(TaskRecurrence, { ...props, error: 'refresh failed' }),
    );
    expect(failed).toMatch(/disabled=""[^>]*>resume repeat work/);
  });
});
