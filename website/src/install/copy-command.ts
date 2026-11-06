export const CLONE_COMMAND = 'git clone https://github.com/fatihguzeldev/lanes.git';

export async function copyInstallCommand(
  clipboard: Pick<Clipboard, 'writeText'> | undefined,
): Promise<boolean> {
  if (!clipboard) return false;

  try {
    await clipboard.writeText(CLONE_COMMAND);
    return true;
  } catch {
    return false;
  }
}
