import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the release contract the updater depends on.
 *
 * Two failures shipped before this file existed and both were invisible to the
 * unit suite: the `v0.19.2` tag pointed at a commit whose `Cargo.lock` still said
 * 0.19.1 (so a tag checkout did not build the tagged version), and the updater
 * endpoint was a `releases/latest/download/latest.json` URL that returned an HTML
 * page, so no installed copy could ever see an update.
 */

const root = join(__dirname, '..', '..', '..');
const conf = JSON.parse(
  readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
) as { plugins?: { updater?: { endpoints?: string[]; pubkey?: string } } };

describe('R1 the updater manifest exists and is well formed', () => {
  it('ships a latest.json at the repo root', () => {
    expect(existsSync(join(root, 'latest.json'))).toBe(true);
  });

  it('carries a version, a signature and a URL per platform', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'latest.json'), 'utf8')) as {
      version: string;
      pub_date: string;
      platforms: Record<string, { signature: string; url: string }>;
    };
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    expect(manifest.version).toBe(pkg.version);
    expect(Number.isNaN(Date.parse(manifest.pub_date))).toBe(false);
    const win = manifest.platforms['windows-x86_64'];
    expect(win).toBeDefined();
    expect(win?.signature.startsWith('dW50cnVzdGVkIGNvbW1lbnQ6')).toBe(true);
    expect(win?.url).toMatch(/^https:\/\//);
    // The filename the updater will fetch must carry the same version, or a user
    // gets "update available" followed by a 404 at download time.
    expect(win?.url).toContain(`v${manifest.version}`);
  });
});

describe('R2 the endpoint can actually return JSON', () => {
  it('points at raw file URLs, never at a release download path', () => {
    const endpoints = conf.plugins?.updater?.endpoints ?? [];
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      // GitCode serves an HTML page for a missing release asset, which a JSON
      // parser cannot read; raw/blob URLs return the file or a JSON error.
      expect(endpoint, endpoint).not.toContain('/releases/latest/download/');
      expect(endpoint, endpoint).toMatch(/latest\.json$/);
    }
  });

  it('lists only hosts verified to serve the file as plain text', () => {
    // Checked by hand on 2026-11-08: Gitee raw and GitHub raw return the JSON,
    // GitCode raw answers "Blob Not Found" for a branch ref and only works with a
    // commit SHA, which changes on every push — so it is not a stable endpoint.
    const endpoints = conf.plugins?.updater?.endpoints ?? [];
    expect(endpoints.some((endpoint) => endpoint.includes('gitee.com/'))).toBe(true);
    expect(endpoints.every((endpoint) => !endpoint.includes('raw.gitcode.com'))).toBe(true);
  });
});

describe('R3 a tag checkout builds the tagged version', () => {
  let tags: string[] = [];

  beforeAll(() => {
    try {
      tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    } catch {
      tags = [];
    }
  });

  it('has no tag whose Cargo.lock disagrees with its package.json', () => {
    // Skips silently on a machine without git history, but on a checkout this is
    // the check that would have caught the v0.19.2 mismatch.
    if (tags.length === 0) return;
    const recent = tags.slice(-3);
    for (const tag of recent) {
      let pkgVersion = '';
      let lockVersion = '';
      try {
        pkgVersion = JSON.parse(execFileSync('git', ['show', `${tag}:package.json`], { cwd: root, encoding: 'utf8' }))
          .version as string;
        lockVersion =
          /name = "creator-studio"\nversion = "([^"]+)"/.exec(
            execFileSync('git', ['show', `${tag}:apps/desktop/src-tauri/Cargo.lock`], { cwd: root, encoding: 'utf8' }),
          )?.[1] ?? '';
      } catch {
        continue;
      }
      expect(lockVersion, `${tag} Cargo.lock`).toBe(pkgVersion);
    }
  });
});
