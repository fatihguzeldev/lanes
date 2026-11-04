import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../icon/Icon';
import { Popover } from '../popover/Popover';
import { stepChoice } from '../select/selection';
import { timeZoneChoices, timeZoneLabel } from './time-zones';
import './TimeZoneSelect.css';

function TimeZoneChoices({
  value,
  onChange,
  close,
}: {
  value: string;
  onChange: (zone: string) => void;
  close: () => void;
}) {
  const choices = useMemo(() => timeZoneChoices(value), [value]);
  const [query, setQuery] = useState(''),
    [active, setActive] = useState(() => choices.findIndex((choice) => choice.value === value));
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const matches = choices.filter((choice) =>
    choice.label
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase().trim().replaceAll('_', ' ')),
  );
  useLayoutEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, query]);
  const choose = (index: number) => {
    const choice = matches[index];
    if (!choice) return;
    onChange(choice.value);
    close();
  };
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === 'Home' || event.key === 'End'
          ? stepChoice(matches, -1, event.key === 'Home' ? 1 : -1)
          : stepChoice(matches, active, event.key === 'ArrowDown' ? 1 : -1);
      setActive(next);
      list.current?.children[next]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
    }
  };
  return (
    <>
      <input
        type="search"
        className="time-zone__search"
        aria-label="search time zones"
        role="combobox"
        aria-expanded="true"
        aria-controls={id}
        aria-autocomplete="list"
        aria-activedescendant={matches[active] ? `${id}-${active}` : undefined}
        value={query}
        placeholder="search time zones"
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={key}
        onFocus={() => list.current?.children[active]?.scrollIntoView({ block: 'nearest' })}
        autoComplete="off"
        autoFocus
      />
      <div id={id} ref={list} role="listbox" aria-label="time zones" className="time-zone__list">
        {matches.map((choice, index) => (
          <div
            key={choice.value}
            id={`${id}-${index}`}
            role="option"
            aria-selected={choice.value === value}
            data-active={active === index || undefined}
            className="select__option"
            onPointerDown={(event) => event.preventDefault()}
            onPointerMove={() => setActive(index)}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              choose(index);
            }}
          >
            <span>{choice.label}</span>
            {choice.value === value && <Icon name="check" size={13} />}
          </div>
        ))}
        {!matches.length && <p className="time-zone__empty">no matching time zones</p>}
      </div>
    </>
  );
}

export function TimeZoneSelect({
  value,
  onChange,
  disabled,
  id,
  'aria-label': label = 'time zone',
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
}: {
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}) {
  return (
    <Popover
      label={label}
      trigger={
        <>
          <span>{timeZoneLabel(value)}</span>
          <Icon name="down" size={13} />
        </>
      }
      className="time-zone__popover"
      triggerClassName="time-zone__trigger"
      {...(disabled !== undefined ? { disabled } : {})}
      {...(id ? { triggerId: id } : {})}
      {...(invalid !== undefined ? { 'aria-invalid': invalid } : {})}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
    >
      {(close) => <TimeZoneChoices value={value} onChange={onChange} close={close} />}
    </Popover>
  );
}
