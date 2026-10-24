import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'creator-studio.theme';

function resolve(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset['theme'] = resolve(mode);
}

export function useTheme(): { mode: ThemeMode; setMode: (mode: ThemeMode) => void } {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'light';
    const stored = window.localStorage.getItem(KEY);
    return stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'system';
  });

  useEffect(() => {
    apply(mode);
    window.localStorage.setItem(KEY, mode);
    if (mode !== 'system' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
  }, []);

  return { mode, setMode };
}

/** Applies the stored theme before first paint (called from main.tsx). */
export function bootTheme(): void {
  if (typeof window === 'undefined') return;
  const stored = window.localStorage.getItem(KEY);
  apply(stored === 'dark' || stored === 'light' ? stored : 'system');
}
