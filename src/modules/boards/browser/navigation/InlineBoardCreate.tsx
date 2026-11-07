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
  }, []);
  return (
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
          readOnly={controller.locked || controller.busy}
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
              if (controller.locked || controller.busy) controller.close();
              else controller.discard();
            }
          }}
          autoComplete="off"
        />
      </div>
      {controller.error && (
        <div className="inline-board-create__error" role="alert">
          <p>{controller.error}</p>
          {controller.locked && (
            <button type="button" onClick={controller.inspect}>
              review save
            </button>
          )}
        </div>
      )}
    </form>
  );
}
