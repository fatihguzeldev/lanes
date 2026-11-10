import { useEffect, useRef, useState } from 'react';
import type { DragDropEventHandlers } from '@dnd-kit/react';
import { isSortable } from '@dnd-kit/dom/sortable';
import type { Task, TaskMoveIntent } from '../../../tasks/contracts/task';
import {
  latestTasks,
  openTaskOrder,
  projectTaskMoves,
} from '../../../tasks/browser/movement/task-move-model';
import type { BoardColumn } from './board-column';
import { captureTaskDrag, resolveTaskDragIntent, type DraggedTask } from './drag-intent';
import { sameTaskMoveContext } from '../../../tasks/model/task-move-context';

interface Options {
  accountId: string;
  columns: readonly BoardColumn[];
  enabled: boolean;
  scope: string;
  pendingTaskIds?: ReadonlySet<string> | undefined;
  onMoveTask?: ((intent: TaskMoveIntent) => void) | undefined;
}
interface Placement {
  listId: string;
  index: number;
}
interface Gesture {
  dragged: DraggedTask;
  task: Task;
  children: readonly Task[];
  scope: string;
  base: readonly BoardColumn[];
  preview: readonly BoardColumn[];
  placement: Placement | null;
  validTarget: boolean;
}
type Manager = Parameters<DragDropEventHandlers['onDragStart']>[1];
type Target = Parameters<DragDropEventHandlers['onDragOver']>[0]['operation']['target'];

function listId(target: Target): string | null {
  if (!target || !['task', 'task-list'].includes(target.data.kind)) return null;
  return typeof target.data.listId === 'string' ? target.data.listId : null;
}

export function useBoardTaskDrag(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const gesture = useRef<Gesture | null>(null);
  const manager = useRef<Manager | null>(null);
  const [preview, setPreview] = useState<readonly BoardColumn[] | null>(null);
  const [announcement, setAnnouncement] = useState('');

  function clear() {
    gesture.current = null;
    manager.current = null;
    setPreview(null);
  }

  function gestureIsCurrent(active: Gesture): boolean {
    const input = latest.current;
    if (!input.enabled || !input.onMoveTask || input.scope !== active.scope) return false;
    const task = captureTaskDrag({ ...input, taskId: active.dragged.taskId });
    const current = latestTasks(input.columns.flatMap((column) => column.tasks)).find(
      (task) => task.accountId === input.accountId && task.id === active.dragged.taskId,
    );
    if (
      !task ||
      !current ||
      task.accountId !== active.dragged.accountId ||
      task.sourceListId !== active.dragged.sourceListId ||
      !sameTaskMoveContext(active.task, current)
    )
      return false;
    const crossList = active.placement && active.placement.listId !== active.dragged.sourceListId;
    const relevant = [active.dragged.sourceListId, active.placement?.listId];
    return relevant.every((id) => {
      if (!id) return true;
      const before = active.base.find((column) => column.list.id === id);
      const after = input.columns.find(
        (column) => column.list.id === id && column.list.accountId === input.accountId,
      );
      return (
        before &&
        after &&
        (!crossList || (after.orderReady ?? after.coverage.complete)) &&
        JSON.stringify(openTaskOrder(before)) === JSON.stringify(openTaskOrder(after))
      );
    });
  }

  function cancel() {
    if (!gesture.current) return;
    gesture.current = null;
    manager.current?.actions.stop({ canceled: true });
    manager.current = null;
    setPreview(null);
    setAnnouncement('task order unchanged.');
  }

  useEffect(() => {
    if (gesture.current && !gestureIsCurrent(gesture.current)) cancel();
  });

  useEffect(() => {
    const blur = () => cancel();
    const visibility = () => {
      if (document.visibilityState === 'hidden') cancel();
    };
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
      gesture.current = null;
      manager.current?.actions.stop({ canceled: true });
      manager.current = null;
    };
  }, []);

  const onBeforeDragStart: DragDropEventHandlers['onBeforeDragStart'] = (event, instance) => {
    const input = latest.current;
    const data = event.operation.source?.data;
    const dragged =
      input.enabled && input.onMoveTask && typeof data?.taskId === 'string'
        ? captureTaskDrag({ ...input, taskId: data.taskId })
        : null;
    if (
      !dragged ||
      data?.kind !== 'task' ||
      data.accountId !== dragged.accountId ||
      data.listId !== dragged.sourceListId ||
      data.revision !== dragged.revision
    ) {
      event.preventDefault();
      return;
    }
    const base = input.columns.filter((column) => column.list.accountId === input.accountId);
    const tasks = latestTasks(base.flatMap((column) => column.tasks));
    const task = tasks.find(
      (item) => item.id === dragged.taskId && item.listId === dragged.sourceListId,
    )!;
    gesture.current = {
      dragged,
      task,
      children: tasks.filter((item) => item.parentId === task.id),
      scope: input.scope,
      base,
      preview: base,
      placement: null,
      validTarget: false,
    };
    manager.current = instance;
  };

  const onDragStart: DragDropEventHandlers['onDragStart'] = (_event, instance) => {
    const active = gesture.current;
    if (!active) return;
    manager.current = instance;
    setPreview(active.base);
    setAnnouncement(`moving ${active.task.title || 'untitled task'}.`);
  };

  const onDragOver: DragDropEventHandlers['onDragOver'] = ({ operation }) => {
    const active = gesture.current;
    if (!active) return;
    const destinationListId = listId(operation.target);
    const destination = active.preview.find((column) => column.list.id === destinationListId);
    const source = active.base.find((column) => column.list.id === active.dragged.sourceListId);
    active.validTarget = Boolean(
      destination &&
      (destination.list.id === active.dragged.sourceListId ||
        ((source?.orderReady ?? source?.coverage.complete) &&
          (destination.orderReady ?? destination.coverage.complete))),
    );
    if (!active.validTarget || !destination || !operation.target) return;
    if (operation.target.data.taskId === active.dragged.taskId) return;
    const siblings = openTaskOrder(destination).filter((id) => id !== active.dragged.taskId);
    let index = siblings.length;
    if (isSortable(operation.target)) {
      const heldList = active.preview.find((column) =>
        openTaskOrder(column).includes(active.dragged.taskId),
      );
      const centerY = operation.shape?.current.center.y ?? operation.position.current.y;
      const below = centerY > (operation.target.shape?.center.y ?? Infinity);
      index = operation.target.sortable.index + (heldList === destination ? 0 : Number(below));
    }
    index = Math.min(siblings.length, Math.max(0, index));
    if (active.placement?.listId === destination.list.id && active.placement.index === index)
      return;
    active.placement = { listId: destination.list.id, index };
    const intent = resolveTaskDragIntent({
      accountId: active.dragged.accountId,
      columns: active.base,
      dragged: active.dragged,
      destinationListId: destination.list.id,
      index,
    });
    active.preview = intent
      ? projectTaskMoves(active.base, [
          {
            id: 'drag-preview',
            intent,
            task: active.task,
            children: active.children,
            readyListIds: [],
            scope: active.scope,
            confirmed: false,
          },
        ])
      : active.base;
    setPreview(active.preview);
  };

  const onDragEnd: DragDropEventHandlers['onDragEnd'] = (event) => {
    const active = gesture.current;
    if (!active) return;
    const input = latest.current;
    const current = captureTaskDrag({ ...input, taskId: active.dragged.taskId });
    const intent =
      !event.canceled &&
      active.validTarget &&
      active.placement &&
      current &&
      listId(event.operation.target) === active.placement.listId &&
      gestureIsCurrent(active)
        ? resolveTaskDragIntent({
            ...input,
            dragged: current,
            destinationListId: active.placement.listId,
            index: active.placement.index,
          })
        : null;
    try {
      if (intent) input.onMoveTask?.(intent);
    } finally {
      clear();
      setAnnouncement(
        intent ? `moved ${active.task.title || 'untitled task'}.` : 'task order unchanged.',
      );
    }
  };

  return {
    columns: preview ?? options.columns,
    dragging: preview !== null,
    announcement,
    onBeforeDragStart,
    onDragStart,
    onDragOver,
    onDragEnd,
  };
}
