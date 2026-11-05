import { useLayoutEffect, useRef } from 'react';

function publishHeaderHeight() {
  const header = [...document.querySelectorAll<HTMLElement>('.workspace__topbar')].find(
    (item) => item.isConnected && getComputedStyle(item).visibility !== 'hidden',
  );
  if (header)
    document.documentElement.style.setProperty(
      '--workspace-header-height',
      `${header.getBoundingClientRect().height}px`,
    );
  else document.documentElement.style.removeProperty('--workspace-header-height');
}

/** Body-portalled task details still respect the visible workspace toolbar. */
export function useWorkspaceHeader() {
  const header = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!header.current) return;
    const observer = new ResizeObserver(publishHeaderHeight);
    observer.observe(header.current);
    publishHeaderHeight();
    return () => {
      observer.disconnect();
      queueMicrotask(publishHeaderHeight);
    };
  }, []);
  return header;
}
