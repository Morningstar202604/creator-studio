import { describe, expect, it } from 'vitest';
import { readCanvasTheme } from '../src/lib/canvasTheme';

describe('R1 canvas theme follows the document theme', () => {
  it('reports light by default and dark when data-theme is dark', () => {
    document.documentElement.dataset['theme'] = 'light';
    expect(readCanvasTheme().mode).toBe('light');
    document.documentElement.dataset['theme'] = 'dark';
    const dark = readCanvasTheme();
    expect(dark.mode).toBe('dark');
    // jsdom returns '' for custom properties, so the fallback must be a real color.
    expect(dark.fg).toMatch(/^#|rgb/);
    document.documentElement.dataset['theme'] = 'light';
  });
});
