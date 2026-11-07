/**
 * Update checking, without making the app depend on the desktop shell.
 *
 * The updater only works inside the Tauri webview. The same build is also served
 * by the daemon as a web page, where there is nothing to install; there the hook
 * reports `unavailable` and the About panel says so instead of offering a button
 * that throws.
 *
 * The plugin is imported lazily, on first use. A static import would pull the
 * Tauri IPC bootstrap into every bundle that touches this module — including the
 * test environment and the web build — which is both wasted bytes and a failure
 * mode: the import resolves but the first call throws outside a Tauri host.
 */

export type UpdateState =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; version: string; notes: string }
  | { kind: 'downloading'; downloaded: number; total: number | null }
  | { kind: 'installed'; version: string }
  | { kind: 'error'; message: string };

type UpdateHandle = {
  version: string;
  body?: string;
  downloadAndInstall: (
    onEvent: (event: { event: string; data: { contentLength?: number; chunkLength?: number } }) => void,
  ) => Promise<void>;
};

/** The single function this module needs from the plugin. Injectable for tests. */
export type UpdateChecker = (options: { timeout: number }) => Promise<UpdateHandle | null>;

export function isDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  // The shell serves from a tauri pseudo-origin; an http origin means the browser
  // build of the same UI.
  return host === 'tauri.localhost' || host.endsWith('.tauri.localhost') || '__TAURI_INTERNALS__' in window;
}

/** A short timeout keeps a blocked network from freezing the panel. */
const CHECK_TIMEOUT_MS = 15_000;

let cachedChecker: UpdateChecker | null = null;

/**
 * Resolves the real plugin once. Kept out of the module's top level so importing
 * this file in a browser or a test never touches the Tauri runtime.
 */
async function defaultChecker(options: { timeout: number }): Promise<UpdateHandle | null> {
  const module = (await import('@tauri-apps/plugin-updater')) as {
    check: (options: { timeout: number }) => Promise<UpdateHandle | null>;
  };
  return module.check(options);
}

async function resolveChecker(injected?: UpdateChecker): Promise<UpdateChecker> {
  if (injected !== undefined) return injected;
  cachedChecker ??= defaultChecker;
  return cachedChecker;
}

export async function checkForUpdate(
  currentVersion: string,
  checker?: UpdateChecker,
): Promise<UpdateState> {
  if (!isDesktopShell()) {
    return { kind: 'unavailable', reason: '浏览器打开的版本不能自助更新，下载新的安装包覆盖安装即可' };
  }
  try {
    const run = await resolveChecker(checker);
    const update = await run({ timeout: CHECK_TIMEOUT_MS });
    if (update === null) return { kind: 'current', version: currentVersion };
    return { kind: 'available', version: update.version, notes: update.body ?? '' };
  } catch (cause) {
    return { kind: 'error', message: friendlyError(cause) };
  }
}

/**
 * Downloads and installs the pending update, reporting progress.
 *
 * The plugin verifies the minisign signature before writing anything, so a
 * tampered installer fails here rather than at next launch. On Windows the app
 * exits when the installer takes over; that is expected, not a crash.
 */
export async function installUpdate(
  onProgress: (state: UpdateState) => void,
  checker?: UpdateChecker,
): Promise<UpdateState> {
  if (!isDesktopShell()) {
    return { kind: 'unavailable', reason: '浏览器打开的版本不能自助更新，下载新的安装包覆盖安装即可' };
  }
  try {
    const run = await resolveChecker(checker);
    const update = await run({ timeout: CHECK_TIMEOUT_MS });
    if (update === null) return { kind: 'current', version: '' };
    let downloaded = 0;
    let total: number | null = null;
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? null;
        onProgress({ kind: 'downloading', downloaded: 0, total });
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength ?? 0;
        onProgress({ kind: 'downloading', downloaded, total });
      }
    });
    return { kind: 'installed', version: update.version };
  } catch (cause) {
    return { kind: 'error', message: friendlyError(cause) };
  }
}

/**
 * Turns updater failures into something a user can act on. The raw errors are
 * either a Rust panic string or a bare URL, neither of which says "check your
 * network" or "no release published yet".
 */
function friendlyError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  if (/timed? ?out|timeout/i.test(raw)) return '检查更新超时：网络不通或被拦截，稍后再试';
  if (/404|not found/i.test(raw)) return '更新源上没有发布信息（可能是还没发版）';
  if (/signature|verify/i.test(raw)) return '安装包签名校验失败，已中止：请从官方发布页重新下载';
  if (/permission|denied/i.test(raw)) return '安装包写入被拒绝，请检查权限后重试';
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}
