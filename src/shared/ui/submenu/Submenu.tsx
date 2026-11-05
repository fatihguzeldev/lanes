import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AnchoredPopover } from '../popover/Popover';
import { Icon } from '../icon/Icon';
import { restoreFocus } from '../focus/restore-focus';
import './Submenu.css';

interface Props {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean, anchor: HTMLElement) => void;
  triggerClassName?: string;
  className?: string;
}

export function Submenu(props: Props) {
  const [localOpen, setLocalOpen] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState<true | 'none'>('none');
  const pointerMode = useRef(true);
  const pointerType = useRef('mouse');
  const open = props.open ?? localOpen;
  const button = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  const cancelClose = () => {
    if (timeout.current !== null) clearTimeout(timeout.current);
    timeout.current = null;
  };
  const change = (next: boolean, fromKeyboard = false) => {
    cancelClose();
    if (!button.current || (next && props.disabled)) return;
    if (next) {
      pointerMode.current = !fromKeyboard;
      setFocusOnOpen(fromKeyboard ? true : 'none');
    }
    if (props.open === undefined) setLocalOpen(next);
    if (next !== open) props.onOpenChange?.(next, button.current);
  };
  const close = () => change(false);
  useEffect(() => cancelClose, []);
  return (
    <div
      ref={region}
      className="submenu"
      data-submenu=""
      onPointerEnter={(event) => {
        cancelClose();
        if (event.pointerType === 'touch' || !window.matchMedia('(hover: hover)').matches) return;
        pointerMode.current = true;
        if (!open) change(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'touch' || !window.matchMedia('(hover: hover)').matches) return;
        if (event.relatedTarget instanceof Node && region.current?.contains(event.relatedTarget))
          return;
        if (pointerMode.current) timeout.current = setTimeout(close, 220);
      }}
    >
      <button
        ref={button}
        type="button"
        className={`popover__item submenu__trigger${props.triggerClassName ? ` ${props.triggerClassName}` : ''}`}
        aria-label={props.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        popoverTarget={open ? id : undefined}
        popoverTargetAction="show"
        disabled={props.disabled}
        onPointerDown={(event) => {
          pointerType.current = event.pointerType;
        }}
        onClick={(event) =>
          change(
            event.detail === 0 || pointerType.current !== 'touch' ? true : !open,
            event.detail === 0,
          )
        }
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            change(true, true);
          }
        }}
      >
        {props.trigger}
        <Icon name="right" size={13} />
      </button>
      {open && button.current && (
        <AnchoredPopover
          anchor={button.current}
          label={props.label}
          id={id}
          placement="side"
          focusOnOpen={focusOnOpen}
          className={`submenu__panel${props.className ? ` ${props.className}` : ''}`}
          onClose={close}
        >
          <div
            className="popover__menu"
            onPointerEnter={(event) => {
              cancelClose();
              if (event.pointerType !== 'touch') pointerMode.current = true;
            }}
            onKeyDown={(event) => {
              pointerMode.current = false;
              if (
                (event.key === 'ArrowLeft' || event.key === 'Escape') &&
                !(
                  event.target instanceof Element &&
                  event.target.closest('[popover]') !== event.currentTarget.closest('[popover]')
                )
              ) {
                event.preventDefault();
                event.stopPropagation();
                change(false, true);
                if (button.current) restoreFocus(button.current, true);
              }
            }}
          >
            <button
              type="button"
              className="popover__item submenu__back"
              aria-label={`back from ${props.label}`}
              onClick={(event) => {
                change(false, event.detail === 0);
                if (button.current) restoreFocus(button.current, event.detail === 0);
              }}
            >
              <Icon name="left" size={14} />
              <span>back</span>
            </button>
            {props.children}
          </div>
        </AnchoredPopover>
      )}
    </div>
  );
}
