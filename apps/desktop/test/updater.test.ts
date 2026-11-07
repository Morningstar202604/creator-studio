import { describe, expect, it } from 'vitest';
import { checkForUpdate, installUpdate, isDesktopShell, type UpdateState } from '../src/features/updater';

/**
 * The updater must degrade honestly outside the desktop shell.
 *
 * Two failure modes are worse than no updater at all: a button that throws in the
 * browser build (the same UI, served by the daemon), and a silent "you are up to
 * date" when the check actually failed. Both are pinned here.
 *
 * The check function is injected rather than module-mocked: `vi.doMock` on the
 * Tauri plugin leaks into other test files in the same worker, which is how this
 * suite once broke every lazy route in the app.
 */

describe('R1 shell detection', () => {
  const original = window.location;

  it('treats a loopback http origin as the browser build', () => {
    Object.defineProperty(window, 'location', { value: { hostname: '127.0.0.1' }, writable: true });
    expect(isDesktopShell()).toBe(false);
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });

  it('treats the tauri pseudo-origin as the desktop shell', () => {
    Object.defineProperty(window, 'location', { value: { hostname: 'tauri.localhost' }, writable: true });
    expect(isDesktopShell()).toBe(true);
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });
});

describe('R2 the browser build explains itself instead of offering a dead button', () => {
  it('returns a reason the panel can show', async () => {
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { hostname: '127.0.0.1' }, writable: true });
    const state: UpdateState = await checkForUpdate('0.19.3');
    expect(state.kind).toBe('unavailable');
    if (state.kind !== 'unavailable') throw new Error('unreachable');
    expect(state.reason).toContain('安装包');
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });

  it('refuses to install from the browser build rather than half-trying', async () => {
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { hostname: 'localhost' }, writable: true });
    const state = await installUpdate(() => {});
    expect(state.kind).toBe('unavailable');
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });
});

describe('R3 real updater results are mapped faithfully', () => {
  it('reports current when the plugin returns null', async () => {
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { hostname: 'tauri.localhost' }, writable: true });
    const state = await checkForUpdate('0.19.3', async () => null);
    expect(state).toEqual({ kind: 'current', version: '0.19.3' });
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });

  it('reports the new version and its notes when one is offered', async () => {
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { hostname: 'tauri.localhost' }, writable: true });
    const state = await checkForUpdate('0.19.3', async () => ({
      version: '0.20.0',
      body: '新东西',
      downloadAndInstall: async () => {},
    }));
    expect(state.kind).toBe('available');
    if (state.kind !== 'available') throw new Error('unreachable');
    expect(state.version).toBe('0.20.0');
    expect(state.notes).toBe('新东西');
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });

  it('streams download progress as bytes arrive', async () => {
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { hostname: 'tauri.localhost' }, writable: true });
    const seen: UpdateState[] = [];
    const state = await installUpdate(
      (progress) => seen.push(progress),
      async () => ({
        version: '0.20.0',
        downloadAndInstall: async (onEvent) => {
          onEvent({ event: 'Started', data: { contentLength: 1000 } });
          onEvent({ event: 'Progress', data: { chunkLength: 400 } });
          onEvent({ event: 'Progress', data: { chunkLength: 600 } });
        },
      }),
    );
    expect(state).toEqual({ kind: 'installed', version: '0.20.0' });
    const last = seen.at(-1);
    expect(last?.kind).toBe('downloading');
    if (last?.kind !== 'downloading') throw new Error('unreachable');
    expect(last.downloaded).toBe(1000);
    expect(last.total).toBe(1000);
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });
});

describe('R4 failures are translated, not leaked raw', () => {
  const original = window.location;

  it('maps a timeout to an actionable message', async () => {
    Object.defineProperty(window, 'location', { value: { hostname: 'tauri.localhost' }, writable: true });
    const state = await checkForUpdate('0.19.3', async () => {
      throw new Error('request timed out after 15000ms');
    });
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') throw new Error('unreachable');
    expect(state.message).toContain('超时');
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });

  it('maps a signature failure and says the install was stopped', async () => {
    Object.defineProperty(window, 'location', { value: { hostname: 'tauri.localhost' }, writable: true });
    const state = await checkForUpdate('0.19.3', async () => {
      throw new Error('signature verification failed');
    });
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') throw new Error('unreachable');
    expect(state.message).toContain('签名');
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });

  it('maps a missing release to "not published yet" rather than a raw URL', async () => {
    Object.defineProperty(window, 'location', { value: { hostname: 'tauri.localhost' }, writable: true });
    const state = await checkForUpdate('0.19.3', async () => {
      throw new Error('404 not found');
    });
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') throw new Error('unreachable');
    expect(state.message).toContain('发布');
    Object.defineProperty(window, 'location', { value: original, writable: true });
  });
});
