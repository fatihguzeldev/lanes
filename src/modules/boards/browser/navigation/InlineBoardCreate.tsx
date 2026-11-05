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
    input.current?.select();
  }, []);
  return (
    <form
      className="inline-board-create"
      onSubmit={(event) => {
        event.preventDefault();
        if (writable) void controller.save();
      }}
    >
      <div className="inline-board-create__row">
        <Icon name="board" size={15} />
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
        <button
          type="submit"
          aria-label="create board"
          disabled={!writable || controller.busy || !controller.title.trim()}
        >
          <Icon name="check" size={14} />
        </button>
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
