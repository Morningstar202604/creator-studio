import { describe, expect, it } from 'vitest';
import { echarts } from '../src/lib/echarts';

/**
 * Smoke test for the modular ECharts build: the module registers six pieces at
 * import time, so a wrong path or a typo in `use([...])` throws here instead of
 * only when the review page opens. It also pins the public surface Chart relies on.
 */
describe('R1 the modular echarts build boots', () => {
  it('exports an initialisable runtime', () => {
    expect(typeof echarts.init).toBe('function');
    expect(typeof echarts.use).toBe('function');
    expect(typeof echarts.version).toBe('string');
  });

  it('registers the charts the app draws rather than the full distribution', () => {
    // `echarts/core` exports ~58 symbols; the full `echarts` entry also exposes
    // every chart/store helper. This pins the module we import, so a future
    // `import 'echarts'` would be caught here even before the bundle grows.
    const names = Object.keys(echarts);
    expect(names).toContain('init');
    expect(names).not.toContain('PieChart');
    expect(names).not.toContain('MapChart');
  });
});
