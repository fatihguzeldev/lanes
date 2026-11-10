import type { LabelPickerPage } from '../labels/useLabels';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { Label, Task } from '../../contracts/task';
import type { TaskEditorController, TaskEditorSession } from './useTaskEditor';
import { TaskEditorWorkspace } from './TaskEditorWorkspace';
import { LabelManager } from '../labels/LabelManager';
import type { TaskCreationController } from '../creation/useTaskCreations';
import type { TaskChangeController } from '../changes/useTaskChanges';

interface Props {
  active?: boolean;
  controller: TaskEditorController;
  creations: TaskCreationController;
  edits: TaskChangeController;
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
  active = true,
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
  const creationEditors = useRef(new Map<number, () => void>());
  const releaseCreationEditor = (id: number) => {
    creationEditors.current.get(id)?.();
    creationEditors.current.delete(id);
  };
  useLayoutEffect(
    () => () => {
      for (const release of creationEditors.current.values()) release();
      creationEditors.current.clear();
    },
    [],
  );
  useLayoutEffect(() => {
    for (const id of creationEditors.current.keys())
      if (id !== session?.id) releaseCreationEditor(id);
  }, [session]);
  useLayoutEffect(() => {
    if (!session) return;
    setSessions((current) =>
      current.some((item) => item.id === session.id)
        ? current
        : [...current, { ...session, boardId: session.selection.boardId ?? boardId }],
    );
  }, [session, boardId]);
  const retire = (id: number) => {
    releaseCreationEditor(id);
    controller.close(id);
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
          presented={active && id === session?.id}
          onBusyChange={(busy) => controller.setSaving(id, busy)}
          onRetire={(hadWork, error, operationId, rejected) => {
            const creation = creations.items.find((item) => item.id === id);
            if (!editor.task && hadWork && error && (!operationId || rejected) && creation) {
              creations.fail(id, error, () =>
                guard(() => {
                  creations.remove(id);
                  controller.recoverCreate(editor, creation.input);
                }),
              );
              retire(id);
              onChanged();
              const message = `couldn’t add ${creation.input.title}. ${error}`;
              if (operationId) onNotice(message, operationId);
              else onNotice(message);
              return;
            }
            if (!editor.task && hadWork && error && operationId && creation) {
              creations.hold(id, operationId, error);
              retire(id);
              onNotice(`couldn’t confirm ${creation.input.title}. ${error}`, operationId);
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
            if (!editor.task) controller.close(id);
            else guard(() => controller.close(id));
            releaseCreationEditor(id);
          }}
          onSaved={(operationId) => {
            if (!editor.task && operationId) void creations.finish(id, operationId);
            else creations.confirm(id);
            edits.confirm(id);
            controller.closeSaved(id);
            retire(id);
            if (editor.task || !operationId) onChanged();
            onAccountsChanged();
          }}
          onSubmitted={() => controller.closeSaved(id)}
          onEditPending={(input) => {
            if (editor.task) edits.start(id, input.baseline ?? editor.task, input);
          }}
          runEdit={edits.run}
          onCreatePending={(input) =>
            creations.start(id, input, (latestInput) =>
              guard(() => {
                const release = creations.retainEditor(id);
                const editorId = controller.editCreation(id, editor, latestInput);
                if (editorId === undefined) release();
                else creationEditors.current.set(editorId, release);
              }),
            )
          }
          onUpdateCreation={creations.update}
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
          presented={active}
          anchor={labelsOpen.anchor}
          initialCreate={labelsOpen.create}
          onBusyChange={(busy) => controller.setSaving('labels', busy)}
          version={version}
          clockOffset={clockOffset}
          onChanged={onChanged}
          onError={onNotice}
          onClose={() => setLabelsOpen(null)}
        />
      )}
    </>
  );
}
