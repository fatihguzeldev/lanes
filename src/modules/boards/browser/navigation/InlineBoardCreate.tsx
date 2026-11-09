import { useLayoutEffect, useRef } from 'react';
import { Icon } from '../../../../shared/ui/icon/Icon';
import type { BoardCreation } from '../management/useBoardCreation';
import './InlineBoardCreate.css';

export function InlineBoardCreate({
  controller,
  writable,
}: {
  controller: BoardCreation;
  writable: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus();
  }, [controller.open]);
  return (
    <>
      {controller.previews
        .filter((entry) => !entry.resource)
        .map((entry) => (
          <div key={entry.identity} className="inline-board-create inline-board-create__row">
            <div className="inline-board-create__field">
              <Icon name="board" size={18} />
              <span className="inline-board-create__title">{entry.title}</span>
            </div>
            {entry.state === 'failed' && (
              <div className="inline-board-create__error" role="alert">
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
      {controller.open && (
        <form
          className="inline-board-create"
          onSubmit={(event) => {
            event.preventDefault();
            if (writable) void controller.save();
          }}
          onBlur={(event) => {
            if (writable && !event.currentTarget.contains(event.relatedTarget))
              void controller.finish();
          }}
        >
          <div className="inline-board-create__row">
            <span className="board-navigation__symbol">
              <Icon name="board" size={18} />
            </span>
            <input
              ref={input}
              aria-label="new board name"
              value={controller.title}
              disabled={!writable}
              aria-invalid={!!controller.error}
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
              autoComplete="off"
            />
          </div>
          {controller.error && (
            <div className="inline-board-create__error" role="alert">
              <p>{controller.error}</p>
            </div>
          )}
        </form>
      )}
    </>
  );
}
