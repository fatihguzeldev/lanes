import type {
  CompletedDeletionAcknowledgements,
  CompletedDeletionConsequences,
} from './completed-deletion-model';

export function CompletedDeletionConfirmation({
  counts,
  acknowledgements,
  onChange,
  disabled,
}: {
  counts: CompletedDeletionConsequences;
  acknowledgements: CompletedDeletionAcknowledgements;
  onChange: (value: CompletedDeletionAcknowledgements) => void;
  disabled: boolean;
}) {
  if (counts.totalDeleteCount === 0)
    return <p>there are no completed tasks in this frozen selection. nothing will be deleted.</p>;
  return (
    <fieldset className="completed-deletion__confirmation" disabled={disabled}>
      <legend>before deleting</legend>
      <label>
        <input
          type="checkbox"
          checked={acknowledgements.permanent}
          onChange={(event) => onChange({ ...acknowledgements, permanent: event.target.checked })}
        />
        <span>
          permanently delete {counts.totalDeleteCount}{' '}
          {counts.totalDeleteCount === 1 ? 'task' : 'tasks'} from google. retained history cannot
          restore them.
        </span>
      </label>
      {counts.openDescendantCount > 0 && (
        <label>
          <input
            type="checkbox"
            checked={acknowledgements.openChildren}
            onChange={(event) =>
              onChange({ ...acknowledgements, openChildren: event.target.checked })
            }
          />
          <span>
            include {counts.openDescendantCount} open subtasks under the completed parents in this
            selection. they will be deleted too.
          </span>
        </label>
      )}
      {counts.assignedTaskCount > 0 && (
        <label>
          <input
            type="checkbox"
            checked={acknowledgements.assignments}
            onChange={(event) =>
              onChange({ ...acknowledgements, assignments: event.target.checked })
            }
          />
          <span>
            delete {counts.assignedTaskCount} source assignments from google docs or chat along with
            their tasks.
          </span>
        </label>
      )}
    </fieldset>
  );
}
