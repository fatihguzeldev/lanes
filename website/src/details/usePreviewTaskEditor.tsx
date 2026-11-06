import { useState } from 'react';
import { PreviewTaskDialogs } from './PreviewTaskDialogs';
import {
  setWorkbenchCompletion,
  setWorkbenchSubtaskCompletion,
  workbenchDraft,
  type WorkbenchDraft,
  type WorkbenchTask,
} from './workbench-data';

export type PreviewTaskEditor = ReturnType<typeof usePreviewTaskEditor>;

export function usePreviewTaskEditor(
  tasks: readonly WorkbenchTask[],
  onChange: (id: string, patch: Partial<WorkbenchTask>) => void,
) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkbenchDraft | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [completionId, setCompletionId] = useState<string | null>(null);
  const task = tasks.find((item) => item.id === editingId);
  const dirty = !!task && !!draft && JSON.stringify(draft) !== JSON.stringify(workbenchDraft(task));
  const completionTask = tasks.find((item) => item.id === completionId) ?? null;
  const openBlockers = (item: WorkbenchTask) =>
    tasks.filter((candidate) => item.blockedBy.includes(candidate.id) && !candidate.completed)
      .length;

  function finishEditing() {
    setEditingId(null);
    setDraft(null);
  }
  function navigate(action: () => void) {
    const leave = () => {
      finishEditing();
      action();
    };
    if (dirty) setPendingAction(() => leave);
    else leave();
  }
  function complete(item: WorkbenchTask, completed: boolean) {
    const latest = tasks.find((candidate) => candidate.id === item.id);
    if (!latest) return;
    if (completed && (latest.subtasks.some((child) => !child.completed) || openBlockers(latest))) {
      setCompletionId(latest.id);
      return;
    }
    const result = setWorkbenchCompletion(latest, completed);
    onChange(latest.id, { completed: result.completed, subtasks: result.subtasks });
  }

  return {
    editingId,
    draft,
    dirty,
    navigate,
    open(item: WorkbenchTask) {
      if (editingId === item.id) return;
      navigate(() => {
        setEditingId(item.id);
        setDraft(workbenchDraft(item));
      });
    },
    patch(value: Partial<WorkbenchDraft>) {
      setDraft((current) => (current ? { ...current, ...value } : current));
    },
    close() {
      if (dirty) setPendingAction(() => finishEditing);
      else finishEditing();
    },
    save() {
      if (!task || !draft || !dirty || !draft.title.trim()) return;
      onChange(task.id, { ...draft, title: draft.title.trim() });
      finishEditing();
    },
    complete,
    completeSubtask(item: WorkbenchTask, index: number, completed: boolean) {
      const latest = tasks.find((candidate) => candidate.id === item.id);
      if (!latest) return;
      const result = setWorkbenchSubtaskCompletion(latest, index, completed);
      onChange(latest.id, { completed: result.completed, subtasks: result.subtasks });
    },
    star(item: WorkbenchTask, starred: boolean) {
      onChange(item.id, { starred });
    },
    dialogs: (
      <PreviewTaskDialogs
        discardOpen={!!pendingAction}
        completionTask={completionTask}
        openBlockers={completionTask ? openBlockers(completionTask) : 0}
        onKeepEditing={() => setPendingAction(null)}
        onDiscard={() => {
          setPendingAction(null);
          pendingAction?.();
        }}
        onCancelCompletion={() => setCompletionId(null)}
        onConfirmCompletion={() => {
          setCompletionId(null);
          if (!completionTask) return;
          const result = setWorkbenchCompletion(completionTask, true);
          onChange(result.id, { completed: result.completed, subtasks: result.subtasks });
        }}
      />
    ),
  };
}
