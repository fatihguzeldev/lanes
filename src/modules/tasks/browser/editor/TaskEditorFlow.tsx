import type { LabelPickerPage } from '../labels/useLabels';
import { useLayoutEffect, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { Label, Task } from '../../contracts/task';
import type { TaskEditorController, TaskEditorSession } from './useTaskEditor';
import { TaskEditorWorkspace } from './TaskEditorWorkspace';
import { LabelManager } from '../labels/LabelManager';
import type { TaskCreationController } from '../creation/useTaskCreations';
import type { TaskEditController } from './useTaskEdits';

interface Props {
  controller: TaskEditorController;
  creations: TaskCreationController;
  edits: TaskEditController;
  account: ConnectionSummary;
  boardId: string | null;
  labels: readonly Label[];
  labelPage?: LabelPickerPage | undefined;
  version: number;
  clockOffset: number;
  guard(action: () => void): void;
  onChanged(): void;
  onAccountsChanged(): void;
  onInspect(id: string): void;
  onOpenTask(task: Task): void;
  onToggleComplete(task: Task, completed: boolean): void;
  onDelete(task: Task): void;
  onNotice(message: string, operationId?: string | null): void;
}
export function TaskEditorFlow({
  controller,
  creations,
  edits,
  account,
  boardId,
  labels,
  labelPage,
  version,
  clockOffset,
  guard,
  onChanged,
  onAccountsChanged,
  onInspect,
  onOpenTask,
  onToggleComplete,
  onDelete,
  onNotice,
}: Props) {
  const session = controller.session;
  const [sessions, setSessions] = useState<Array<TaskEditorSession & { boardId: string | null }>>(
    () => (session ? [{ ...session, boardId: session.selection.boardId ?? boardId }] : []),
  );
  useLayoutEffect(() => {
    if (!session) return;
    setSessions((current) =>
      current.some((item) => item.id === session.id)
        ? current
        : [...current, { ...session, boardId: session.selection.boardId ?? boardId }],
    );
  }, [session, boardId]);
  const retire = (id: number) => {
    controller.setSaving(id, false);
    setSessions((current) => current.filter((item) => item.id !== id));
  };
  const [labelsOpen, setLabelsOpen] = useState<{ anchor: HTMLElement; create: boolean } | null>(
    null,
  );
  return (
    <>
      {sessions.map(({ id, selection: editor, boardId: editorBoard }) => (
        <TaskEditorWorkspace
          key={`${account.id}:${id}`}
          account={account}
          selection={editor}
          boardId={editorBoard}
          presented={id === session?.id}
          onBusyChange={(busy) => controller.setSaving(id, busy)}
          onRetire={(hadWork, error, operationId) => {
            const creation = creations.items.find((item) => item.id === id);
            if (!editor.task && hadWork && error && !operationId && creation) {
              creations.fail(id, error, () =>
                guard(() => {
                  creations.remove(id);
                  controller.recoverCreate(editor, creation.input);
                }),
              );
              retire(id);
              onChanged();
              onNotice(`couldn’t add ${creation.input.title}. ${error}`);
              return;
            }
            creations.remove(id);
            edits.remove(id);
            retire(id);
            if (hadWork) onChanged();
            if (error)
              onNotice(
                `saving ${editor.task?.title || 'this task'} needs attention. ${error}`,
                operationId,
              );
          }}
          labels={labels}
          labelPage={labelPage}
          version={version}
          clockOffset={clockOffset}
          onChanged={onChanged}
          onClose={() => {
            if (labelsOpen) return;
            if (editor.inlineCreate) controller.close(id);
            else guard(() => controller.close(id));
          }}
          onSaved={() => {
            creations.confirm(id);
            edits.confirm(id);
            controller.closeSaved(id);
            retire(id);
            onChanged();
            onAccountsChanged();
          }}
          onSubmitted={() => controller.closeSaved(id)}
          onEditPending={(input) => {
            if (editor.task) edits.start(id, input.baseline ?? editor.task, input);
          }}
          runEdit={edits.run}
          onCreatePending={(input) => creations.start(id, input)}
          onInspectChange={onInspect}
          onDirtyChange={(dirty) => controller.setDirty(dirty, id)}
          onOpenTask={onOpenTask}
          onToggleComplete={onToggleComplete}
          onDelete={onDelete}
          onCreateSubtask={(task) => guard(() => controller.createSubtask(task))}
          onManageLabels={(anchor, create) => setLabelsOpen({ anchor, create: !!create })}
        />
      ))}
      {labelsOpen && (
        <LabelManager
          account={account}
          anchor={labelsOpen.anchor}
          initialCreate={labelsOpen.create}
          onBusyChange={(busy) => controller.setSaving('labels', busy)}
          version={version}
          clockOffset={clockOffset}
          onChanged={onChanged}
          onClose={() => setLabelsOpen(null)}
        />
      )}
    </>
  );
}
