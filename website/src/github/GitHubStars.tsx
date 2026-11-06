import { useEffect, useState } from 'react';
import { fetchGitHubStars, GITHUB_URL } from './github-stars';
import './GitHubStars.css';

export function GitHubStars() {
  const [stars, setStars] = useState<number | 'loading' | 'unavailable'>('loading');

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    fetchGitHubStars(controller.signal)
      .then((count) => {
        if (active) setStars(count);
      })
      .catch(() => {
        if (active) setStars('unavailable');
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, []);

  const count = typeof stars === 'number' ? new Intl.NumberFormat('en-US').format(stars) : '—';
  const label =
    typeof stars === 'number'
      ? `View lanes on GitHub, ${count} ${stars === 1 ? 'star' : 'stars'}`
      : `View lanes on GitHub. Star count ${stars === 'loading' ? 'loading' : 'unavailable'}`;

  return (
    <a className="github-stars" href={GITHUB_URL} aria-label={label}>
      <svg
        className="github-stars__mark"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.76-.24.76-.54v-2.1c-3.12.68-3.78-1.33-3.78-1.33-.51-1.3-1.24-1.64-1.24-1.64-1.02-.7.08-.68.08-.68 1.12.08 1.72 1.15 1.72 1.15 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.49-.28-5.11-1.25-5.11-5.54 0-1.22.44-2.22 1.15-3-.11-.29-.5-1.43.11-2.97 0 0 .94-.3 3.08 1.15a10.7 10.7 0 0 1 5.6 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.54.22 2.68.11 2.96.72.79 1.15 1.79 1.15 3.01 0 4.3-2.63 5.25-5.13 5.53.4.35.76 1.03.76 2.08v3.1c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z" />
      </svg>
      <span>GitHub</span>
      <span className="github-stars__count" aria-hidden="true">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="m10 2.3 2.3 4.66 5.14.75-3.72 3.63.88 5.12L10 14.04l-4.6 2.42.88-5.12-3.72-3.63 5.14-.75L10 2.3Z" />
        </svg>
        <span>{count}</span>
      </span>
    </a>
  );
}
