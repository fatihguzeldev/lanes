import { useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { Label, Task } from '../../contracts/task';
import type { TaskEditorController } from './useTaskEditor';
import { TaskEditorWorkspace } from './TaskEditorWorkspace';
import { LabelManager } from '../labels/LabelManager';

interface Props {
  controller: TaskEditorController;
  account: ConnectionSummary;
  boardId: string | null;
  labels: readonly Label[];
  version: number;
  clockOffset: number;
  guard(action: () => void): void;
  onChanged(): void;
  onAccountsChanged(): void;
  onInspect(id: string): void;
  onOpenTask(task: Task): void;
  onToggleComplete(task: Task, completed: boolean): void;
  onDelete(task: Task): void;
}
export function TaskEditorFlow({
  controller,
  account,
  boardId,
  labels,
  version,
  clockOffset,
  guard,
  onChanged,
  onAccountsChanged,
  onInspect,
  onOpenTask,
  onToggleComplete,
  onDelete,
}: Props) {
  const editor = controller.selection;
  const [labelsOpen, setLabelsOpen] = useState(false);
  return (
    <>
      {editor && (
        <TaskEditorWorkspace
          key={`${account.id}:${editor.task?.id ?? `new:${editor.list.id}:${editor.parent?.id ?? ''}`}`}
          account={account}
          selection={editor}
          boardId={editor.boardId ?? boardId}
          labels={labels}
          version={version}
          clockOffset={clockOffset}
          onChanged={onChanged}
          onClose={() =>
            guard(() => {
              controller.close();
            })
          }
          onSaved={() => {
            controller.close();
            onChanged();
            onAccountsChanged();
          }}
          onInspectChange={onInspect}
          onDirtyChange={controller.setDirty}
          onOpenTask={onOpenTask}
          onToggleComplete={onToggleComplete}
          onDelete={onDelete}
          onCreateSubtask={(task) => guard(() => controller.createSubtask(task))}
          onManageLabels={() => setLabelsOpen(true)}
        />
      )}
      {labelsOpen && (
        <LabelManager
          account={account}
          version={version}
          clockOffset={clockOffset}
          onChanged={onChanged}
          onClose={() => setLabelsOpen(false)}
        />
      )}
    </>
  );
}
