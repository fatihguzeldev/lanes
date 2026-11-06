import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskCard } from './TaskCard';
import { usePreviewTaskEditor } from './usePreviewTaskEditor';
import { workbenchTasks, type WorkbenchTask } from './workbench-data';

function Cards({ tasks }: { tasks: WorkbenchTask[] }) {
  const editor = usePreviewTaskEditor(tasks, () => {});
  return createElement(
    Fragment,
    null,
    tasks.map((task, index) =>
      createElement(TaskCard, { key: task.id, task, tasks, editor, initialExpanded: index === 0 }),
    ),
  );
}

describe('reusable task cards', () => {
  it('keeps each checklist target unique and opens only the requested initial checklist', () => {
    const markup = renderToStaticMarkup(createElement(Cards, { tasks: workbenchTasks }));
    const controls = [...markup.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1]);

    expect(controls).toHaveLength(workbenchTasks.length);
    expect(new Set(controls).size).toBe(controls.length);
    for (const id of controls) expect(markup).toContain(`id="${id}"`);
    expect(markup.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(workbenchTasks.length - 1);
    for (const task of workbenchTasks) expect(markup).toContain(`data-task-id="${task.id}"`);
  });

  it('renders a plain task without empty notes, metadata or a zero-item checklist', () => {
    const task = {
      ...workbenchTasks[0]!,
      notes: '  ',
      labels: [],
      day: '',
      time: '',
      blockedBy: [],
      priority: 'none' as const,
      subtasks: [],
    };
    const markup = renderToStaticMarkup(createElement(Cards, { tasks: [task] }));

    expect(markup).toContain(task.title);
    expect(markup).not.toMatch(/<(?:p|input)\b/);
    expect(markup).not.toContain('subtasks of');
    expect(markup).not.toContain('0/0');
    expect(markup).not.toContain('aria-controls=');
  });
});
