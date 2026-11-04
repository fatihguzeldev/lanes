import type { ConnectionSummary } from '../../accounts/contracts';
import type { BoardList } from '../../boards/contracts';
import { Select } from '../../../shared/ui/select/Select';
import { Icon } from '../../../shared/ui/icon/Icon';
import { TransferPages } from './TransferFeedback';
import type { BoardLists } from './useBoardLists';
export function AccountChoice({
  accounts,
  value,
  onChange,
  label,
  disabled = false,
  exclude,
}: {
  accounts: readonly ConnectionSummary[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  disabled?: boolean;
  exclude?: string;
}) {
  return (
    <label>
      {label}
      <Select
        value={value}
        onChange={(selectedValue) => onChange(selectedValue)}
        disabled={disabled}
        aria-label={label}
        options={[
          ...accounts
            .filter((account) => account.id !== exclude)
            .map((account) => ({
              value: account.id,
              label: `${account.email} · ${account.state.replaceAll('_', ' ')}`,
            })),
        ]}
      />
    </label>
  );
}
export function BoardChoice({
  resource,
  disabled = false,
  label = 'board',
}: {
  resource: BoardLists;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <>
      <label>
        {label}
        <Select
          value={resource.boardId}
          disabled={disabled}
          onChange={(selectedValue) => resource.setBoardId(selectedValue)}
          aria-label={label}
          options={[
            { value: '', label: 'choose a board' },
            ...resource.boards.items.map((board) => ({
              value: board.id,
              label: `${board.title}${board.isMain ? ' · main' : ''}`,
            })),
          ]}
        />
      </label>
      <TransferPages resource={resource.boards} />
    </>
  );
}
export function ListSelection({
  resource,
  selected,
  onChange,
  maximum,
  disabled = false,
}: {
  resource: BoardLists;
  selected: readonly BoardList[];
  onChange: (lists: BoardList[]) => void;
  maximum: number;
  disabled?: boolean;
}) {
  return (
    <>
      <BoardChoice resource={resource} disabled={disabled} />
      {resource.boardId && (
        <>
          <div className="transfer__checklist">
            {resource.lists.items.map((list) => (
              <label className="transfer__check" key={list.id}>
                <input
                  type="checkbox"
                  checked={selected.some((item) => item.id === list.id)}
                  disabled={
                    disabled ||
                    (!selected.some((item) => item.id === list.id) && selected.length >= maximum)
                  }
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, list]
                        : selected.filter((item) => item.id !== list.id),
                    )
                  }
                />
                {list.title}
              </label>
            ))}
          </div>
          <TransferPages resource={resource.lists} />
        </>
      )}
      <p>
        {selected.length} lists selected · maximum {maximum}. selections from other boards remain
        selected.
      </p>
      {selected.length > 0 && (
        <div className="transfer__chips">
          {selected.map((list) => (
            <button
              type="button"
              key={list.id}
              disabled={disabled}
              onClick={() => onChange(selected.filter((item) => item.id !== list.id))}
            >
              {list.title}
              <Icon name="close" size={11} />
            </button>
          ))}
        </div>
      )}
    </>
  );
}
export function DestinationChoice({
  resource,
  kind,
  setKind,
  listId,
  setListId,
  disabled,
}: {
  resource: BoardLists;
  kind: 'new' | 'existing';
  setKind: (kind: 'new' | 'existing') => void;
  listId: string;
  setListId: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <label>
        destination
        <Select
          value={kind}
          onChange={(selectedValue) => setKind(selectedValue as 'new' | 'existing')}
          aria-label="destination"
          options={[
            { value: 'new', label: 'create distinct new lists' },
            { value: 'existing', label: 'append to an existing list' },
          ]}
        />
      </label>
      <BoardChoice resource={resource} label="destination board" />
      {kind === 'existing' && (
        <>
          <label>
            destination list
            <Select
              value={listId}
              onChange={(selectedValue) => setListId(selectedValue)}
              aria-label="destination list"
              options={[
                { value: '', label: 'choose a list' },
                ...resource.lists.items.map((list) => ({ value: list.id, label: list.title })),
              ]}
            />
          </label>
          {resource.boardId && <TransferPages resource={resource.lists} />}
        </>
      )}
      <p>
        {kind === 'new'
          ? 'equal titles create separate lists; existing content is preserved.'
          : 'mapped list names will not change this explicit destination. no list slot is consumed.'}
      </p>
    </fieldset>
  );
}
