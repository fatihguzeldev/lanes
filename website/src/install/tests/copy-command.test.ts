import { describe, expect, it, vi } from 'vitest';
import { AGENT_PROMPT, CLONE_COMMAND, copyText } from '../copy-command';

describe('copy installation text', () => {
  it('copies the complete clone command when the clipboard accepts it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    expect(await copyText(CLONE_COMMAND, { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('git clone https://github.com/fatihguzeldev/lanes.git');
  });

  it('copies the suggested agent prompt with case-sensitive guide paths intact', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    expect(await copyText(AGENT_PROMPT, { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith(
      'deploy lanes to my cloudflare account. follow AGENTS.md and agents/self-hosting.md.',
    );
  });

  it('reports failure when the clipboard API is unavailable', async () => {
    expect(await copyText(CLONE_COMMAND, undefined)).toBe(false);
  });

  it('reports failure when browser clipboard permission is denied', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('Not allowed', 'NotAllowedError'));

    expect(await copyText(AGENT_PROMPT, { writeText })).toBe(false);
  });
});
