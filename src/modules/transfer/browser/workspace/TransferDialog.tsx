import { lazy, Suspense, useState } from 'react';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';
import type { Task } from '../../../tasks/contracts/task';
import { readTask } from '../../../tasks/browser/queries/references';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
import { portabilityLanding } from './landing';

const TransferWorkspace = lazy(() =>
  import('./TransferWorkspace').then((module) => ({ default: module.TransferWorkspace })),
);
export function useTransferDialog(accountId: string) {
  const [open, setOpen] = useState(() => portabilityLanding()?.accountId === accountId);
  const [dirty, setDirty] = useState(false);
  const [initialTab] = useState(() => portabilityLanding()?.tab ?? 'import');
  return {
    open,
    dirty,
    initialTab,
    setDirty,
    show() {
      setOpen(true);
    },
    close() {
      setOpen(false);
      setDirty(false);
    },
  };
}
interface Props {
  active?: boolean;
  controller: ReturnType<typeof useTransferDialog>;
  account: ConnectionSummary;
  accounts: readonly ConnectionSummary[];
  clockOffset: number;
  version: number;
  guard(action: () => void): void;
  onChanged(): void;
  onInspect(id: string): void;
  onOpenTask(task: Task): void;
  onNotice(message: string): void;
}
export function TransferDialog({
  active = true,
  controller,
  account,
  accounts,
  clockOffset,
  version,
  guard,
  onChanged,
  onInspect,
  onOpenTask,
  onNotice,
}: Props) {
  return (
    <>
      {controller.open && (
        <Dialog
          presented={active}
          title="import, export and transfer"
          wide
          onClose={() =>
            guard(() => {
              controller.close();
            })
          }
        >
          <Suspense
            fallback={<div className="dialog__body">opening your files and transfers…</div>}
          >
            <TransferWorkspace
              account={account}
              accounts={accounts}
              clockOffset={clockOffset}
              version={version}
              initialTab={controller.initialTab}
              onChanged={onChanged}
              onDirtyChange={controller.setDirty}
              onOpenOperation={(id) => {
                onInspect(id);
              }}
              onOpenTask={(reference) => {
                if (reference.accountId !== account.id) {
                  onNotice('choose the destination account to inspect its copied task.');
                  return;
                }
                void readTask(account.id, reference.taskId)
                  .then(onOpenTask)
                  .catch((error) =>
                    onNotice(
                      error instanceof Error
                        ? error.message
                        : 'this result is no longer available.',
                    ),
                  );
              }}
            />
          </Suspense>
        </Dialog>
      )}
    </>
  );
}
