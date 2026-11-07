import { useMemo } from 'react';
import type { BoardList } from '../../contracts/board';
import type { Task } from '../../../tasks/contracts/task';
import type { TaskPlacement } from './useTaskPlacement';
import { useTaskQuery } from '../../../tasks/browser/queries/useTaskQuery';
import { Icon } from '../../../../shared/ui/icon/Icon';
import { Submenu } from '../../../../shared/ui/submenu/Submenu';
import { Skeleton } from '../../../../shared/ui/skeleton/Skeleton';

export interface TaskMoveContext {
  controller: TaskPlacement;
  task: Task;
  disabled: boolean;
}
interface PlacementProps extends TaskMoveContext {
  list: BoardList;
  parent?: Task | null;
}

export function TaskMovePlacement({
  controller,
  task,
  disabled,
  list,
  parent = null,
}: PlacementProps) {
  const choose = (position: 'first' | 'last') =>
    controller.choose({ list, position, parent, previous: null });
  return (
    <>
      <button
        type="button"
        className="popover__item"
        disabled={disabled}
        onClick={() => choose('first')}
      >
        <Icon name="up" size={14} /> first {parent ? 'under this task' : 'in list'}
      </button>
      <button
        type="button"
        className="popover__item"
        disabled={disabled}
        onClick={() => choose('last')}
      >
        <Icon name="down" size={14} /> last {parent ? 'under this task' : 'in list'}
      </button>
      <Submenu
        label="after a task"
        trigger={
          <>
            <Icon name="arrow" size={14} />
            <span>after a task</span>
          </>
        }
        disabled={disabled}
      >
        <TaskMoveTasks
          controller={controller}
          task={task}
          disabled={disabled}
          list={list}
          parent={parent}
          mode="after"
        />
      </Submenu>
      {!parent && task.capabilities.canNest && !task.repeatRule && (
        <Submenu
          label="under a task"
          trigger={
            <>
              <Icon name="subtasks" size={14} />
              <span>under a task</span>
            </>
          }
          disabled={disabled}
        >
          <TaskMoveTasks
            controller={controller}
            task={task}
            disabled={disabled}
            list={list}
            mode="parents"
          />
        </Submenu>
      )}
    </>
  );
}

function TaskMoveTasks({
  controller,
  task,
  disabled,
  list,
  parent = null,
  mode,
}: PlacementProps & { mode: 'parents' | 'after' }) {
  const query = useMemo(
    () => ({
      listIds: [list.id],
      parentId: mode === 'after' ? (parent?.id ?? null) : null,
      filter: { completion: 'all' as const },
      sort: 'manual' as const,
    }),
    [list.id, parent?.id, mode],
  );
  const tasks = useTaskQuery(task.accountId, query);
  const eligible = tasks.page.items.filter(
    (item) =>
      item.accountId === task.accountId &&
      item.listId === list.id &&
      item.id !== task.id &&
      (mode === 'parents'
        ? !item.parentId && item.capabilities.canHaveChildren && !item.unsupportedHierarchy
        : item.parentId === (parent?.id ?? null)),
  );
  return (
    <>
      {eligible.map((item) => (
        <div className="task-move-picker__destination" key={item.id}>
          <button
            type="button"
            className="popover__item"
            disabled={disabled}
            onClick={() =>
              controller.choose({
                list,
                position: mode === 'parents' ? 'last' : 'after',
                parent: mode === 'parents' ? item : parent,
                previous: mode === 'after' ? item : null,
              })
            }
          >
            <Icon name={mode === 'parents' ? 'subtasks' : 'arrow'} size={14} />
            <span>{item.title || 'untitled task'}</span>
          </button>
          {mode === 'parents' && (
            <Submenu
              label={`position under ${item.title || 'untitled task'}`}
              trigger={null}
              triggerClassName="task-move-picker__more"
              disabled={disabled}
            >
              <TaskMovePlacement
                controller={controller}
                task={task}
                disabled={disabled}
                list={list}
                parent={item}
              />
            </Submenu>
          )}
        </div>
      ))}
      {tasks.status === 'loading' && !tasks.loaded && (
        <div className="task-move-picker__loading" aria-label="loading tasks" role="status">
          {[0, 1, 2].map((key) => (
            <Skeleton className="task-move-picker__loading-line" key={key} />
          ))}
        </div>
      )}
      {tasks.loaded && !tasks.error && !eligible.length && (
        <p className="task-move-picker__message">
          {mode === 'parents'
            ? tasks.page.coverage.complete
              ? 'no eligible parents.'
              : 'no eligible parents to show yet.'
            : tasks.page.coverage.complete
              ? 'no other tasks in this group.'
              : 'no other tasks to show yet.'}
        </p>
      )}
      {tasks.error && (
        <button type="button" className="popover__item" onClick={() => void tasks.reload()}>
          retry tasks
        </button>
      )}
      {tasks.page.nextCursor && (
        <button
          type="button"
          className="popover__item"
          disabled={tasks.status === 'loading'}
          onClick={() => void tasks.loadMore()}
        >
          more tasks
        </button>
      )}
    </>
  );
}
