import { useLayoutEffect, useRef } from 'react';
import { Icon } from '../../../../shared/ui/icon/Icon';
import type { ListCreation } from './useListCreation';
import './InlineListCreate.css';

export function InlineListCreate({
  controller,
  writable,
}: {
  controller: ListCreation;
  writable: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus();
  }, [controller.open]);
  return (
    <>
      {controller.previews
        .filter((entry) => entry.boardId === controller.currentBoardId && !entry.resource)
        .map((entry) => (
          <div key={entry.identity} className="inline-list-create inline-list-create--submitted">
            <div className="inline-list-create__field">
              <Icon name="list" size={16} />
              <span className="inline-list-create__title">{entry.title}</span>
            </div>
            {entry.state === 'failed' && (
              <div className="inline-list-create__error" role="alert">
                <p>{entry.error}</p>
                <button type="button" onClick={() => controller.inspect(entry.identity)}>
                  review save
                </button>
                {entry.rejected ? (
                  <button type="button" onClick={() => controller.editFailed(entry.identity)}>
                    edit name
                  </button>
                ) : (
                  <button type="button" onClick={() => controller.retry(entry.identity)}>
                    retry this save
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      {controller.open && controller.boardId === controller.currentBoardId && (
        <form
          className="inline-list-create"
          onSubmit={(event) => {
            event.preventDefault();
            if (writable) void controller.save();
          }}
          onBlur={(event) => {
            if (writable && !event.currentTarget.contains(event.relatedTarget))
              void controller.finish();
          }}
        >
          <div className="inline-list-create__field">
            <Icon name="plus" size={14} />
            <input
              ref={input}
              aria-label="new list name"
              maxLength={1024}
              value={controller.title}
              disabled={!writable}
              aria-invalid={!!controller.error}
              autoComplete="off"
              onChange={(event) => controller.change(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                  if (event.key === 'Enter') event.preventDefault();
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  controller.discard();
                }
              }}
            />
          </div>
          {controller.error && (
            <div className="inline-list-create__error" role="alert">
              <p>{controller.error}</p>
            </div>
          )}
        </form>
      )}
    </>
  );
}
