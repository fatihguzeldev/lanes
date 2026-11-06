import { useEffect, useId, useRef } from 'react';
import type { WorkbenchTask } from './workbench-data';

type Props = {
  discardOpen: boolean;
  completionTask: WorkbenchTask | null;
  openBlockers: number;
  onKeepEditing(): void;
  onDiscard(): void;
  onCancelCompletion(): void;
  onConfirmCompletion(): void;
};

export function PreviewTaskDialogs({
  discardOpen,
  completionTask,
  openBlockers,
  onKeepEditing,
  onDiscard,
  onCancelCompletion,
  onConfirmCompletion,
}: Props) {
  const discardId = useId();
  const completionId = useId();
  const discardDialog = useRef<HTMLDialogElement>(null);
  const completionDialog = useRef<HTMLDialogElement>(null);
  const openChildren = completionTask?.subtasks.filter((child) => !child.completed).length ?? 0;
  useEffect(() => {
    if (discardOpen) discardDialog.current?.showModal();
    else discardDialog.current?.close();
  }, [discardOpen]);
  useEffect(() => {
    if (completionTask) completionDialog.current?.showModal();
    else completionDialog.current?.close();
  }, [completionTask]);

  return (
    <>
      <dialog
        ref={discardDialog}
        className="workbench-confirm"
        aria-labelledby={discardId}
        onCancel={(event) => {
          event.preventDefault();
          discardDialog.current?.close();
          onKeepEditing();
        }}
      >
        <h2 id={discardId}>leave this draft?</h2>
        <p>your unsaved changes will be discarded.</p>
        <div>
          <button
            type="button"
            onClick={() => {
              discardDialog.current?.close();
              onKeepEditing();
            }}
          >
            keep editing
          </button>
          <button
            type="button"
            onClick={() => {
              discardDialog.current?.close();
              onDiscard();
            }}
          >
            discard draft
          </button>
        </div>
      </dialog>
      <dialog
        ref={completionDialog}
        className="workbench-confirm"
        aria-labelledby={completionId}
        onCancel={(event) => {
          event.preventDefault();
          completionDialog.current?.close();
          onCancelCompletion();
        }}
      >
        <h2 id={completionId}>complete this task?</h2>
        <p>
          {openChildren > 0 && `${openChildren} open subtasks will also be completed.`}
          {openBlockers > 0 && ' this task still has open blockers.'}
        </p>
        <div>
          <button
            type="button"
            onClick={() => {
              completionDialog.current?.close();
              onCancelCompletion();
            }}
          >
            cancel
          </button>
          <button
            type="button"
            onClick={() => {
              completionDialog.current?.close();
              onConfirmCompletion();
            }}
          >
            complete task
          </button>
        </div>
      </dialog>
    </>
  );
}
