import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskDetails } from './TaskDetails';
import { workbenchLabels, workbenchTasks } from './workbench-data';

describe('task details initial showcase', () => {
  it('shows one focal task card without opening an editor or rendering filler tasks', () => {
    const markup = renderToStaticMarkup(createElement(TaskDetails));
    const focal = workbenchTasks[0]!;

    expect(markup.match(/<article\b/g)).toHaveLength(1);
    expect(markup).not.toMatch(/<(?:form|textarea)\b/);
    expect(markup).toContain(focal.title);
    for (const other of workbenchTasks.slice(1)) {
      expect(markup).not.toContain(other.title);
    }
  });

  it('shows the focal task notes, schedule, labels and expanded checklist immediately', () => {
    const markup = renderToStaticMarkup(createElement(TaskDetails));
    const article = markup.match(/<article\b[^>]*>([\s\S]*?)<\/article>/)?.[1] ?? '';
    const focal = workbenchTasks[0]!;
    const date = new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    })
      .format(new Date(`${focal.day}T12:00:00Z`))
      .toLowerCase();

    expect(article).toContain(focal.notes.split('\n')[0]);
    expect(article).toContain(date);
    expect(article).toContain(focal.time);
    for (const label of workbenchLabels.filter((item) => focal.labels.includes(item.id))) {
      expect(article).toContain(label.name);
    }
    for (const child of focal.subtasks) {
      expect(article).toContain(child.title);
    }
    const checklistToggle = [...article.matchAll(/<button\b[^>]*>/g)].find(([button]) =>
      button.includes(`aria-label="subtasks of ${focal.title}"`),
    )?.[0];
    expect(checklistToggle).toContain('aria-expanded="true"');
  });
});
