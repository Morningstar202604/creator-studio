import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const tauriConf = JSON.parse(
  readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
) as {
  plugins?: { updater?: { pubkey?: string; endpoints?: string[] } };
  bundle?: { createUpdaterArtifacts?: boolean; targets?: string[] };
  version?: string;
};
const cargoToml = readFileSync(join(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
const libRs = readFileSync(join(root, 'apps/desktop/src-tauri/src/lib.rs'), 'utf8');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

describe('R1 updater is wired end to end', () => {
  it('declares the plugin dependency, registers it, and pins a public key', () => {
    expect(cargoToml).toContain('tauri-plugin-updater');
    expect(libRs).toContain('tauri_plugin_updater::Builder');
    expect(tauriConf.plugins?.updater?.pubkey).toMatch(/^[A-Za-z0-9+/=]{60,}$/);
    expect(tauriConf.plugins?.updater?.endpoints?.length).toBeGreaterThan(0);
  });

  it('asks the bundler to emit updater artifacts', () => {
    expect(tauriConf.bundle?.createUpdaterArtifacts).toBe(true);
  });

  it('keeps the config version in step with the workspace version', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    expect(tauriConf.version).toBe(pkg.version);
    expect(cargoToml).toContain(`version = "${pkg.version}"`);
  });

  it('does not commit a private signing key', () => {
    // The private key must only ever arrive through TAURI_SIGNING_PRIVATE_KEY.
    for (const relative of ['apps/desktop/src-tauri/tauri.conf.json', 'apps/desktop/src-tauri/Cargo.toml']) {
      const text = readFileSync(join(root, relative), 'utf8');
      expect(text).not.toMatch(/untrusted comment: minisign encrypted secret key/);
      expect(text).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    }
    expect(existsSync(join(root, 'apps/desktop/src-tauri/updater.key'))).toBe(false);
  });
});

describe('R2 CI covers all three desktop platforms', () => {
  it('runs verify on ubuntu, windows and macOS', () => {
    expect(ci).toContain('os: [ubuntu-latest, windows-latest, macos-latest]');
  });

  it('builds a native bundle per platform', () => {
    expect(ci).toMatch(/os: windows-latest[\s\S]{0,120}bundle: nsis/);
    expect(ci).toMatch(/os: ubuntu-latest[\s\S]{0,120}bundle: deb/);
    expect(ci).toMatch(/os: macos-latest[\s\S]{0,120}bundle: dmg/);
  });

  it('installs the Linux WebKit toolchain and passes the signing key by secret', () => {
    expect(ci).toContain('libwebkit2gtk-4.1-dev');
    expect(ci).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY');
  });
});
