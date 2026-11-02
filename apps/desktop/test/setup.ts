import { afterEach } from 'vitest';
import { cleanup, configure as configureRtl } from '@testing-library/react';

/**
 * Async UI assertions must not race the test runner. `waitFor` defaults to a
 * 1000ms budget, which is enough when a file runs alone but not when the whole
 * workspace suite runs in parallel on a loaded machine — the same assertions
 * then fail intermittently, and a flaky gate is a gate nobody trusts. The budget
 * below is a ceiling, not a delay: a passing assertion still settles immediately.
 * Per-test timeouts live in `vitest.config.ts` so this file stays DOM-only.
 */
configureRtl({ asyncUtilTimeout: 5_000 });

/**
 * jsdom ships no canvas backend. Commands such as Cytoscape throw "Could not create
 * canvas of type 2d" and Vitest reports it as an unhandled error, so a minimal 2d
 * stub is installed once for every test file. Components that need real pixels are
 * verified in the browser harness instead.
 */
// `diff.test.ts` runs in the node environment (no DOM), so this must be guarded.
const proto =
  typeof HTMLCanvasElement === 'undefined'
    ? null
    : (HTMLCanvasElement.prototype as HTMLCanvasElement & { getContext: (contextId: string) => unknown });
// jsdom's own getContext throws a "not implemented" error when called, so the check
// must not invoke it. Install the stub unconditionally instead.
if (proto !== null && typeof proto.getContext === 'function') {
  proto.getContext = function stubGetContext(contextId: string): unknown {
    if (contextId !== '2d') return null;
    return {
      canvas: this,
      save: () => undefined,
      restore: () => undefined,
      scale: () => undefined,
      rotate: () => undefined,
      translate: () => undefined,
      clearRect: () => undefined,
      fillRect: () => undefined,
      strokeRect: () => undefined,
      beginPath: () => undefined,
      closePath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      bezierCurveTo: () => undefined,
      quadraticCurveTo: () => undefined,
      arc: () => undefined,
      fill: () => undefined,
      stroke: () => undefined,
      clip: () => undefined,
      measureText: () => ({ width: 0 }),
      fillText: () => undefined,
      strokeText: () => undefined,
      setTransform: () => undefined,
      drawImage: () => undefined,
      createLinearGradient: () => ({ addColorStop: () => undefined }),
      getImageData: () => ({ data: [] }),
      putImageData: () => undefined,
      createImageData: () => ({ data: [] }),
      setLineDash: () => undefined,
      getLineDash: () => [],
    };
  };
}

afterEach(() => {
  cleanup();
});
