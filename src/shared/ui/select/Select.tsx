import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AnchoredPopover } from '../popover/Popover';
import { Icon } from '../icon/Icon';
import { findChoice, stepChoice, type Choice } from './selection';
import './Select.css';

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly Choice[];
  id?: string;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

export function Select({
  value,
  onChange,
  options,
  id,
  className,
  disabled,
  required,
  ...aria
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const selected = options.findIndex((option) => option.value === value);
  const [active, setActive] = useState(selected);
  const button = useRef<HTMLButtonElement>(null);
  const prefix = useRef({ text: '', time: 0 });
  const listId = useId();
  const activeId = active >= 0 && options[active] ? `${listId}-${active}` : undefined;
  useLayoutEffect(() => {
    if (open && activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeId]);
  useLayoutEffect(() => {
    if (open && button.current?.matches(':disabled')) setOpen(false);
  });
  const show = (last = false) => {
    if (button.current?.matches(':disabled')) return;
    setActive(
      selected >= 0 && !options[selected]?.disabled
        ? selected
        : stepChoice(options, -1, last ? -1 : 1),
    );
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled || button.current?.matches(':disabled')) return;
    if (option.value !== value) onChange(option.value);
    setOpen(false);
  };
  const key = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show(event.key === 'ArrowUp');
      else setActive(stepChoice(options, active, event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive(stepChoice(options, -1, event.key === 'Home' ? 1 : -1));
      setOpen(true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(active);
      else show();
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'Tab') setOpen(false);
    else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      const text = now - prefix.current.time < 700 ? prefix.current.text + event.key : event.key;
      prefix.current = { text, time: now };
      const repeated = [...text].every((letter) => letter === text[0]);
      const next = findChoice(options, repeated ? event.key : text, repeated ? active + 1 : 0);
      if (next >= 0) {
        setActive(next);
        setOpen(true);
      }
    }
  };
  return (
    <span className={`select${className ? ` ${className}` : ''}`}>
      <button
        ref={button}
        id={id}
        type="button"
        role="combobox"
        className="select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? activeId : undefined}
        aria-required={required || undefined}
        disabled={disabled}
        {...aria}
        onKeyDown={key}
        onClick={() => (open ? setOpen(false) : show())}
      >
        <span>{options[selected]?.label ?? value}</span>
        <Icon name="down" size={13} />
      </button>
      {open && button.current && (
        <AnchoredPopover
          anchor={button.current}
          label={aria['aria-label'] ?? 'options'}
          onClose={() => setOpen(false)}
          focusOnOpen={false}
          role="presentation"
          className="select__popover"
        >
          <div
            id={listId}
            role="listbox"
            aria-label={aria['aria-label']}
            aria-labelledby={aria['aria-labelledby']}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                data-active={active === index || undefined}
                className="select__option"
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => !option.disabled && setActive(index)}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  choose(index);
                }}
              >
                <span>{option.label}</span>
                {option.value === value && <Icon name="check" size={13} />}
              </div>
            ))}
          </div>
        </AnchoredPopover>
      )}
    </span>
  );
}
