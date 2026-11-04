import { useEffect, useState } from 'react';
export type Theme = 'light' | 'dark' | 'system';
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const value = localStorage.getItem('lanes.theme');
      return value === 'light' || value === 'dark' ? value : 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
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
  return [theme, setTheme] as const;
}
