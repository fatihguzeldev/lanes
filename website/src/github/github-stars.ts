export const GITHUB_URL = 'https://github.com/fatihguzeldev/lanes';

export async function fetchGitHubStars(signal: AbortSignal): Promise<number> {
  const response = await fetch('https://api.github.com/repos/fatihguzeldev/lanes', {
    signal,
    headers: { Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error('GitHub star count unavailable');

  const data: unknown = await response.json();
  if (
    typeof data !== 'object' ||
    data === null ||
    !('stargazers_count' in data) ||
    typeof data.stargazers_count !== 'number' ||
    !Number.isSafeInteger(data.stargazers_count) ||
    data.stargazers_count < 0
  ) {
    throw new Error('Invalid GitHub star count');
  }
  return data.stargazers_count;
}
