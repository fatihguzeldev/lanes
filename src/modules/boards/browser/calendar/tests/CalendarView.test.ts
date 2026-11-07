import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CalendarView, type CalendarViewProps } from '../CalendarView';
import { CreateTaskSchema } from '../../../../tasks/contracts/task';

const noop = () => {};
const props: CalendarViewProps = {
  accountId: 'account',
  boardId: 'board',
  tasks: [],
  lists: [],
  today: '2026-11-05',
  accountTimeZone: 'UTC',
  weekStart: 1,
  mode: 'month',
  scope: 'board',
  coverage: { complete: true, stale: false, lastSyncedAt: null },
  onModeChange: noop,
  onScopeChange: noop,
  onOpenTask: noop,
  onTaskMenu: noop,
  onCreateTask: noop,
  onReschedule: noop,
  onLoadMore: noop,
  onRetry: noop,
};

describe('calendar navigation and horizontal grid', () => {
  it.each(['month', 'week'] as const)(
    'keeps %s controls outside a keyboard-focusable grid',
    (mode) => {
      const html = renderToStaticMarkup(createElement(CalendarView, { ...props, mode }));
      const region = html.indexOf(`role="region" aria-label="${mode} calendar" tabindex="0"`);
      expect(region).toBeGreaterThan(0);
      expect(html.indexOf(`aria-label="previous ${mode}"`)).toBeLessThan(region);
      expect(html.indexOf('aria-label="calendar scope"')).toBeLessThan(region);
      expect(html.indexOf('<table')).toBeGreaterThan(region);
      expect(html.indexOf('class="calendar-view__unscheduled"')).toBeGreaterThan(
        html.indexOf('</table>'),
      );
    },
  );
  it('keeps admitted creations visible in their day or unscheduled section without saving labels', () => {
    const html = renderToStaticMarkup(
      createElement(CalendarView, {
        ...props,
        creations: [
          {
            id: 1,
            confirmedAfter: null,
            input: CreateTaskSchema.parse({
              accountId: 'account',
              listId: 'list',
              title: 'dated creation',
              scheduledDay: props.today,
            }),
          },
          {
            id: 2,
            confirmedAfter: null,
            input: CreateTaskSchema.parse({
              accountId: 'account',
              listId: 'list',
              title: 'undated creation',
            }),
          },
          {
            id: 3,
            confirmedAfter: null,
            input: CreateTaskSchema.parse({
              accountId: 'other',
              listId: 'list',
              title: 'foreign creation',
            }),
          },
        ],
      }),
    );
    expect(html).toContain('dated creation');
    expect(html).toContain('undated creation');
    expect(html).not.toContain('foreign creation');
    expect(html.indexOf('dated creation')).toBeLessThan(html.indexOf('calendar-view__unscheduled'));
    expect(html).not.toContain('no unscheduled tasks in this view');
    expect(html).not.toContain('saving');
  });
});
