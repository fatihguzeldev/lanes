import { useState, type ComponentProps } from 'react';
import { Dialog } from '../../../../shared/ui/dialog/Dialog';
import { ChangeStatus } from './ChangeStatus';

export function useChangeInspection() {
  const [operationId, setOperationId] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [resolutionId, setResolutionId] = useState<string | null>(null);
  return {
    operationId,
    visible,
    resolutionId,
    inspect(id: string | null) {
      setOperationId(id);
      setVisible(true);
    },
    close() {
      setVisible(false);
    },
    resolve: setResolutionId,
    closeResolution() {
      setResolutionId(null);
    },
  };
}
type Props = Omit<ComponentProps<typeof ChangeStatus>, 'operationId' | 'onClose' | 'onResolve'> & {
  controller: ReturnType<typeof useChangeInspection>;
};
export function ChangeInspection({ controller, ...props }: Props) {
  return controller.visible && controller.operationId ? (
    <Dialog title="change status" onClose={controller.close}>
      <ChangeStatus
        {...props}
        operationId={controller.operationId}
        onClose={controller.close}
        onResolve={controller.resolve}
      />
    </Dialog>
  ) : null;
}
