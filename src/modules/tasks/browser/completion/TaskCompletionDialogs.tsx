import { useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { Task, TaskList } from '../../contracts/task';
import type { ReopenPreview } from '../../contracts/recurrence';
import { CompletedDeletionDialog } from './CompletedDeletionDialog';
import { ReopenDialog } from '../planning/ReopenDialog';

export function useTaskCompletion() {
  const [reopen, setReopen] = useState<{ task: Task; preview: ReopenPreview } | null>(null);
  const [completedDeletionList, setCompletedDeletionList] = useState<TaskList | null>(null);
  return {
    reopen,
    completedDeletionList,
    openReopen: setReopen,
    openDeletion: setCompletedDeletionList,
    closeReopen: () => setReopen(null),
    closeDeletion: () => setCompletedDeletionList(null),
  };
}
interface Props {
  controller: ReturnType<typeof useTaskCompletion>;
  account: ConnectionSummary;
  clockOffset: number;
  onChanged(): void;
  onRepeat(): Promise<unknown>;
  onInspect(id: string): void;
}
export function TaskCompletionDialogs({
  controller,
  account,
  clockOffset,
  onChanged,
  onRepeat,
  onInspect,
}: Props) {
  const { reopen, completedDeletionList } = controller;
  return (
    <>
      {completedDeletionList && (
        <CompletedDeletionDialog
          key={`${account.id}:${completedDeletionList.id}`}
          account={account}
          list={completedDeletionList}
          clockOffset={clockOffset}
          onClose={() => controller.closeDeletion()}
          onChanged={onChanged}
          onInspect={(id) => {
            controller.closeDeletion();
            onInspect(id);
          }}
        />
      )}
      {reopen && (
        <ReopenDialog
          accountId={account.id}
          title={reopen.task.title}
          preview={reopen.preview}
          clockOffset={clockOffset}
          onClose={() => controller.closeReopen()}
          onAdmitted={() => {
            onChanged();
            void onRepeat();
          }}
        />
      )}
    </>
  );
}
