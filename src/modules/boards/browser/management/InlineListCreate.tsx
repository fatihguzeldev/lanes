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
  }, []);
  return (
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
          readOnly={controller.locked || controller.busy}
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
              if (controller.locked || controller.busy) controller.close();
              else controller.discard();
            }
          }}
        />
      </div>
      {controller.error && (
        <div className="inline-list-create__error" role="alert">
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
