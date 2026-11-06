import { useEffect, useRef, useState } from 'react';
import { useOutsideDismiss } from '../dismiss/useOutsideDismiss';
import './InlineField.css';

export function InlineField({
  value,
  initialDraft,
  label,
  onCommit,
  onCancel,
  disabled = false,
  allowEmpty = false,
  autoFocus = false,
  placeholder,
  maxLength,
  type = 'text',
}: {
  value: string;
  initialDraft?: string | undefined;
  label: string;
  onCommit(value: string): boolean | Promise<boolean>;
  onCancel?: () => void;
  disabled?: boolean;
  allowEmpty?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  maxLength?: number;
  type?: 'text' | 'url';
}) {
  const [draft, setDraft] = useState(initialDraft ?? value);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const current = useRef(initialDraft ?? value);
  const latestValue = useRef(value);
  latestValue.current = value;
  const dirty = useRef(initialDraft !== undefined && initialDraft !== value);
  const flight = useRef(false);
  const escaped = useRef(false);
  useEffect(() => {
    if (autoFocus) {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    }
  }, [autoFocus]);
  useEffect(() => {
    if (!dirty.current && !flight.current) {
      current.current = value;
      setDraft(value);
    }
  }, [value]);
  async function commit() {
    if (disabled || flight.current || escaped.current || !dirty.current) return;
    const next = current.current.trim();
    if (next === value || (!next && !allowEmpty)) {
      dirty.current = false;
      current.current = value;
      setDraft(value);
      setError('');
      return;
    }
    flight.current = true;
    setSaving(true);
    setError('');
    try {
      if (await onCommit(next)) {
        dirty.current = false;
        const confirmed = latestValue.current !== value ? latestValue.current : next;
        current.current = confirmed;
        setDraft(confirmed);
      } else setError('couldn’t save this change.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'couldn’t save this change.');
    } finally {
      flight.current = false;
      setSaving(false);
    }
  }
  useOutsideDismiss(field, () => void commit());
  return (
    <div ref={field} className="inline-field">
      <input
        ref={input}
        type={type}
        aria-label={label}
        aria-invalid={!!error}
        value={draft}
        disabled={disabled}
        readOnly={saving}
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(event) => {
          escaped.current = false;
          dirty.current = true;
          current.current = event.target.value;
          setDraft(event.target.value);
          setError('');
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            void commit();
            input.current?.blur();
          }
          if (event.key === 'Escape' && !flight.current) {
            event.preventDefault();
            event.stopPropagation();
            escaped.current = true;
            dirty.current = false;
            current.current = value;
            setDraft(value);
            setError('');
            input.current?.blur();
            onCancel?.();
          }
        }}
      />
      {error && (
        <p className="inline-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
