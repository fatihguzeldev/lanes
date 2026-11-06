import { Icon } from '../../../../shared/ui/icon/Icon';
import './InlineTaskCreate.css';

interface Props {
  accountId: string;
  listId: string;
  enabled: boolean;
  onCreate(): void;
}

export function InlineTaskCreate({ accountId, listId, enabled, onCreate }: Props) {
  return (
    <div className="inline-task-create" data-task-create-host={listId} data-account-id={accountId}>
      <button
        className="inline-task-create__open"
        type="button"
        disabled={!enabled}
        onClick={onCreate}
      >
        <Icon name="plus" size={13} />
        add a task
      </button>
    </div>
  );
}
