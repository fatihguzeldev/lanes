import { Icon } from '../../../../shared/ui/icon/Icon';
import './InlineTaskCreate.css';

export function InlineTaskCreatePlaceholder() {
  return (
    <button type="button" tabIndex={-1} className="inline-task-create__open" aria-hidden="true">
      <Icon name="plus" size={13} />
      add a task
    </button>
  );
}
