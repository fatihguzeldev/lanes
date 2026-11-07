import { useState } from 'react';
import { Icon } from '../icon/Icon';
import { InlineField } from '../inline-field/InlineField';
import { colorChoices, colorInk, normalizeColor } from './colors';
import './ColorPicker.css';

export function ColorPreview({ value }: { value: string }) {
  return (
    <span
      className="color-preview"
      style={{ backgroundColor: normalizeColor(value) ?? undefined }}
      aria-hidden="true"
    />
  );
}

export function ColorPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange(value: string): boolean | Promise<boolean>;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  const selected = normalizeColor(value);
  return (
    <div className="color-picker">
      <div className="color-picker__choices" role="group" aria-label="colors">
        {colorChoices.map((color) => (
          <button
            key={color.value}
            type="button"
            aria-label={color.name}
            title={color.name}
            aria-pressed={selected === color.value}
            disabled={disabled}
            onClick={() => {
              if (selected !== color.value) void onChange(color.value);
            }}
          >
            <span
              className="color-picker__swatch"
              style={{ backgroundColor: color.value, color: colorInk(color.value) }}
            >
              {selected === color.value && <Icon name="check" size={15} />}
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="color-picker__custom"
        aria-expanded={custom}
        disabled={disabled}
        onClick={() => setCustom(!custom)}
      >
        <ColorPreview value={value} /> <span>custom color</span>
        <Icon name={custom ? 'up' : 'down'} size={13} />
      </button>
      {custom && (
        <InlineField
          value={value}
          label="custom hex color"
          disabled={disabled}
          maxLength={7}
          onCommit={(text) => {
            const color = normalizeColor(text);
            if (!color) throw new Error('enter a color such as #82966f.');
            return color === selected || onChange(color);
          }}
        />
      )}
    </div>
  );
}
