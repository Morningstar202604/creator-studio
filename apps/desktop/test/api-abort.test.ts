import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiExtra } from '../src/api';

describe('R6 request cancellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes an optional signal through the styles request', async () => {
    let seenSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenSignal = init?.signal;
        return new Response(JSON.stringify({ styles: [] }), { status: 200 });
      }),
    );
    const controller = new AbortController();

    await expect(apiExtra.styles(controller.signal)).resolves.toEqual({ styles: [] });
    expect(seenSignal).toBe(controller.signal);
  });

  it('preserves AbortError instead of reporting daemon unreachable', async () => {
    const abortError = new DOMException('aborted', 'AbortError');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw abortError;
      }),
    );

    await expect(apiExtra.styles(new AbortController().signal)).rejects.toBe(abortError);
  });
});
