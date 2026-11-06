import { useState } from 'react';
import { Icon } from '../icon/Icon';
import { InlineField } from '../inline-field/InlineField';
import './EmojiPicker.css';

const choices = [
  ['🌱', 'seedling'],
  ['🌿', 'herb'],
  ['🍃', 'leaf'],
  ['🌻', 'sunflower'],
  ['☀️', 'sun'],
  ['🌙', 'moon'],
  ['⭐', 'star'],
  ['☁️', 'cloud'],
  ['🏡', 'home'],
  ['☕', 'coffee'],
  ['📚', 'books'],
  ['✏️', 'pencil'],
  ['💻', 'computer'],
  ['🧪', 'experiment'],
  ['🎨', 'art'],
  ['🎬', 'film'],
  ['🎵', 'music'],
  ['📷', 'camera'],
  ['🎮', 'game'],
  ['🧩', 'puzzle'],
  ['🛠️', 'tools'],
  ['💼', 'work'],
  ['🗓️', 'calendar'],
  ['💡', 'idea'],
  ['🧭', 'compass'],
  ['🏕️', 'camping'],
  ['🚲', 'bicycle'],
  ['✈️', 'travel'],
  ['🍋', 'lemon'],
  ['🍑', 'peach'],
  ['🥑', 'avocado'],
  ['🐈', 'cat'],
] as const;

export function EmojiPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null;
  onChange(value: string | null): boolean | Promise<boolean>;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const matches = choices.filter(
    ([emoji, name]) => name.includes(query.trim().toLowerCase()) || emoji === query.trim(),
  );
  return (
    <div className="emoji-picker">
      <input
        className="emoji-picker__search"
        type="search"
        aria-label="search emoji"
        placeholder="find an emoji"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="emoji-picker__choices" role="group" aria-label="emoji">
        {matches.map(([emoji, name]) => (
          <button
            key={emoji}
            type="button"
            title={name}
            aria-label={name}
            aria-pressed={value === emoji}
            disabled={disabled}
            onClick={() => {
              if (value !== emoji) void onChange(emoji);
            }}
          >
            <span aria-hidden="true">{emoji}</span>
            {value === emoji && <Icon name="check" size={11} className="emoji-picker__selected" />}
          </button>
        ))}
      </div>
      {!matches.length && (
        <p className="emoji-picker__empty">no matching emoji. you can paste one below.</p>
      )}
      <InlineField
        value={value ?? ''}
        label="custom emoji"
        placeholder="paste an emoji"
        disabled={disabled}
        maxLength={64}
        onCommit={(text) => onChange(text)}
      />
      <button
        className="emoji-picker__clear"
        type="button"
        disabled={disabled || value === null}
        onClick={() => void onChange(null)}
      >
        <Icon name="close" size={14} /> remove emoji
      </button>
    </div>
  );
}
