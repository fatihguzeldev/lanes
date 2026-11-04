import { useEffect, useState } from 'react';
export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = Exclude<Theme, 'system'>;

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const value = localStorage.getItem('lanes.theme');
      return value === 'light' || value === 'dark' ? value : 'system';
    } catch {
      return 'system';
    }
  });
  const [resolvedTheme, setResolvedTheme] = useState(() =>
    resolveTheme(
      theme,
      typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
    ),
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = resolveTheme(theme, media.matches);
      setResolvedTheme(resolved);
      document.documentElement.dataset.theme = resolved;
      document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
        meta.content = resolved === 'dark' ? '#222222' : '#f3f3f1';
      });
    };
    apply();
    media.addEventListener('change', apply);
    try {
      localStorage.setItem('lanes.theme', theme);
    } catch {
      /* A presentation preference must not prevent entry. */
    }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme, resolvedTheme] as const;
}
