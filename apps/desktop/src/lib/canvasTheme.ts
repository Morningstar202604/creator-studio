import { useEffect, useState } from 'react';

/**
 * Colors for canvas-rendered surfaces (Cytoscape, ECharts).
 *
 * Those libraries cannot read CSS custom properties, so every canvas that draws
 * text has to be handed concrete colors. Reading them from the live token set keeps
 * one source of truth for light and dark, and a MutationObserver on `data-theme`
 * re-renders the canvas when the user flips the theme — previously the diagrams
 * stayed light-on-light (or white labels on a dark canvas) until a reload.
 */

export type CanvasTheme = {
  mode: 'light' | 'dark';
  surface: string;
  raised: string;
  border: string;
  borderStrong: string;
  fg: string;
  muted: string;
  subtle: string;
  accent: string;
  warn: string;
  danger: string;
  ok: string;
  info: string;
};

const FALLBACK: CanvasTheme = {
  mode: 'light',
  surface: '#ffffff',
  raised: '#fcfbf8',
  border: '#dedbd4',
  borderStrong: '#878277',
  fg: '#1a1a18',
  muted: '#5f5c56',
  subtle: '#68645c',
  accent: '#2e6f6a',
  warn: '#8a5e12',
  danger: '#b83a2e',
  ok: '#2f6b43',
  info: '#35567d',
};

const TOKENS: Array<[keyof Omit<CanvasTheme, 'mode'>, string]> = [
  ['surface', '--surface'],
  ['raised', '--raised'],
  ['border', '--border'],
  ['borderStrong', '--border-strong'],
  ['fg', '--fg'],
  ['muted', '--muted'],
  ['subtle', '--subtle'],
  ['accent', '--accent'],
  ['warn', '--warn'],
  ['danger', '--danger'],
  ['ok', '--ok'],
  ['info', '--info'],
];

export function readCanvasTheme(): CanvasTheme {
  if (typeof document === 'undefined') return FALLBACK;
  const root = document.documentElement;
  const styles = typeof getComputedStyle === 'function' ? getComputedStyle(root) : null;
  const mode = root.dataset['theme'] === 'dark' ? 'dark' : 'light';
  const theme: CanvasTheme = { ...FALLBACK, mode };
  for (const [key, token] of TOKENS) {
    const value = styles?.getPropertyValue(token).trim() ?? '';
    // jsdom returns '' for custom properties; the fallback keeps tests deterministic.
    if (value !== '') theme[key] = value;
  }
  return theme;
}

export function useCanvasTheme(): CanvasTheme {
  const [theme, setTheme] = useState<CanvasTheme>(() => readCanvasTheme());

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => setTheme(readCanvasTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    // The first paint can happen before the token stylesheet is applied; one extra
    // read on the next frame avoids a canvas drawn with fallback colors.
    const timer = window.setTimeout(() => setTheme(readCanvasTheme()), 0);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  return theme;
}
