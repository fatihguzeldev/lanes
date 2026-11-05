import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CalendarView, type CalendarViewProps } from '../CalendarView';

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
});
