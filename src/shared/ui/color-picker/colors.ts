export const colorChoices = [
  { name: 'stone', value: '#f1f0e9' },
  { name: 'moss', value: '#82966f' },
  { name: 'sage', value: '#9dac9b' },
  { name: 'sand', value: '#c4ae7b' },
  { name: 'clay', value: '#bf8a72' },
  { name: 'rose', value: '#bd91a1' },
  { name: 'slate', value: '#849aaf' },
  { name: 'lilac', value: '#a295b5' },
] as const;

export function normalizeColor(value: string): string | null {
  const color = value.trim().toLowerCase();
  if (/^#[\da-f]{6}$/.test(color)) return color;
  return /^#[\da-f]{3}$/.test(color)
    ? '#' + [...color.slice(1)].map((channel) => channel + channel).join('')
    : null;
}

export function colorInk(value: string): '#202020' | '#ffffff' {
  const color = normalizeColor(value) ?? '#f1f0e9';
  const channels = [1, 3, 5].map((offset) => {
    const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return luminance > 0.179 ? '#202020' : '#ffffff';
}
