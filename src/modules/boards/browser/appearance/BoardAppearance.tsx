import { useState } from 'react';
import type { Board, BoardPatch } from '../../contracts/board';
import { ColorPicker, ColorPreview } from '../../../../shared/ui/color-picker/ColorPicker';
import { EmojiPicker } from '../../../../shared/ui/emoji-picker/EmojiPicker';
import { InlineField } from '../../../../shared/ui/inline-field/InlineField';
import { Popover } from '../../../../shared/ui/popover/Popover';
import { Select } from '../../../../shared/ui/select/Select';
import { Icon } from '../../../../shared/ui/icon/Icon';
import './BoardAppearance.css';

export function BoardAppearance({
  board,
  disabled,
  onChange,
}: {
  board: Board;
  disabled: boolean;
  onChange(input: BoardPatch): Promise<boolean>;
}) {
  const [customBackground, setCustomBackground] = useState(false);
  const background = board.backgroundUrl ?? '';
  const custom = !!background && !background.startsWith('/backgrounds/');
  return (
    <div className="board-appearance">
      <InlineField
        label="board name"
        value={board.title}
        disabled={disabled}
        maxLength={256}
        onCommit={(title) => onChange({ title })}
      />
      <Popover
        label="board emoji"
        trigger={
          <>
            <span className="board-appearance__emoji" aria-hidden="true">
              {board.emoji ?? <Icon name="board" size={16} />}
            </span>
            <span>emoji</span>
            <Icon name="right" size={13} />
          </>
        }
        triggerClassName="board-appearance__choice"
        disabled={disabled}
      >
        {(close) => (
          <EmojiPicker
            value={board.emoji}
            disabled={disabled}
            onChange={async (emoji) => {
              const done = await onChange({ emoji });
              if (done) close();
              return done;
            }}
          />
        )}
      </Popover>
      <Popover
        label="board color"
        trigger={
          <>
            <ColorPreview value={board.color} />
            <span>color</span>
            <Icon name="right" size={13} />
          </>
        }
        triggerClassName="board-appearance__choice"
        disabled={disabled}
      >
        {(close) => (
          <ColorPicker
            value={board.color}
            disabled={disabled}
            onChange={async (color) => {
              const done = await onChange({ color });
              if (done) close();
              return done;
            }}
          />
        )}
      </Popover>
      <label className="board-appearance__background">
        background
        <Select
          value={customBackground || custom ? 'custom' : background}
          aria-label="board background"
          disabled={disabled}
          onChange={(value) => {
            setCustomBackground(value === 'custom');
            if (value !== 'custom') void onChange({ backgroundUrl: value || null });
          }}
          options={[
            { value: '', label: 'color only' },
            { value: '/backgrounds/lines.svg', label: 'quiet lines' },
            { value: '/backgrounds/circles.svg', label: 'soft shapes' },
            { value: 'custom', label: 'an image url' },
          ]}
        />
      </label>
      {(customBackground || custom) && (
        <div>
          <InlineField
            label="https image url"
            value={custom ? background : ''}
            type="url"
            placeholder="https://"
            maxLength={4096}
            allowEmpty
            disabled={disabled}
            onCommit={(url) => onChange({ backgroundUrl: url || null })}
          />
          <small>your browser contacts this image host when opening the board.</small>
        </div>
      )}
    </div>
  );
}
