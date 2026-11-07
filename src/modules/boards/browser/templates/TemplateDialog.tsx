import { lazy, Suspense, useState } from 'react';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
import type { ConnectionSummary } from '../../../accounts/contracts/connection';

const TemplateWorkspace = lazy(() =>
  import('./TemplateWorkspace').then((module) => ({ default: module.TemplateWorkspace })),
);
export function useTemplateDialog() {
  const [open, setOpen] = useState(false),
    [opened, setOpened] = useState(false),
    [dirty, setDirty] = useState(false);
  return {
    open,
    opened,
    dirty,
    setDirty,
    show() {
      setOpened(true);
      setOpen(true);
    },
    close() {
      setOpen(false);
      setDirty(false);
    },
  };
}
interface Props {
  controller: ReturnType<typeof useTemplateDialog>;
  account: ConnectionSummary;
  clockOffset: number;
  version: number;
  guard(action: () => void): void;
  onChanged(): void;
  onInspect(id: string): void;
  onRefreshInventory(): void;
  active?: boolean;
  onNotice?: (message: string, operationId?: string) => void;
}
export function TemplateDialog({
  controller,
  account,
  clockOffset,
  version,
  guard,
  onChanged,
  onInspect,
  onRefreshInventory,
  active = true,
  onNotice,
}: Props) {
  return controller.opened ? (
    <Suspense
      fallback={
        active && controller.open ? (
          <Dialog title="templates" wide onClose={() => controller.close()}>
            <div className="dialog__body" role="status">
              loading…
            </div>
          </Dialog>
        ) : null
      }
    >
      <TemplateWorkspace
        account={account}
        clockOffset={clockOffset}
        version={version}
        presented={active && controller.open}
        onClose={() => guard(() => controller.close())}
        onChanged={onChanged}
        onDirtyChange={controller.setDirty}
        onOpenOperation={onInspect}
        onRefreshInventory={onRefreshInventory}
        onNotice={onNotice}
      />
    </Suspense>
  ) : null;
}
