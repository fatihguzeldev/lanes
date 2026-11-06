import { describe, expect, it, vi } from 'vitest';
import { CLONE_COMMAND, copyInstallCommand } from '../copy-command';

describe('copy installation command', () => {
  it('copies the complete clone command when the clipboard accepts it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    expect(await copyInstallCommand({ writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('git clone https://github.com/fatihguzeldev/lanes.git');
    expect(CLONE_COMMAND).toBe('git clone https://github.com/fatihguzeldev/lanes.git');
  });

  it('reports failure when the clipboard API is unavailable', async () => {
    expect(await copyInstallCommand(undefined)).toBe(false);
  });

  it('reports failure when browser clipboard permission is denied', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('Not allowed', 'NotAllowedError'));

    expect(await copyInstallCommand({ writeText })).toBe(false);
  });
});
