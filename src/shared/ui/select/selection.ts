export interface Choice {
  value: string;
  label: string;
  disabled?: boolean;
}

export function stepChoice(choices: readonly Choice[], from: number, direction: 1 | -1): number {
  let index = from < 0 ? (direction === 1 ? -1 : choices.length) : from;
  for (let count = 0; count < choices.length; count++) {
    index = (index + direction + choices.length) % choices.length;
    if (!choices[index]?.disabled) return index;
  }
  return -1;
}

export function findChoice(choices: readonly Choice[], prefix: string, from: number): number {
  const text = prefix.toLocaleLowerCase();
  for (let count = 0; count < choices.length; count++) {
    const index = (Math.max(0, from) + count) % choices.length;
    const choice = choices[index];
    if (choice && !choice.disabled && choice.label.toLocaleLowerCase().startsWith(text))
      return index;
  }
  return -1;
}
