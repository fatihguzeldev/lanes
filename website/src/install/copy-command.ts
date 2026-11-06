export const CLONE_COMMAND = 'git clone https://github.com/fatihguzeldev/lanes.git';
export const AGENT_PROMPT =
  'deploy lanes to my cloudflare account. follow AGENTS.md and agents/self-hosting.md.';

export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined,
): Promise<boolean> {
  if (!clipboard) return false;

  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
