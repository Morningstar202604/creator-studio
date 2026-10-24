import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Local secret vault. API keys never go into SQLite (which gets copied around with
 * the project database) and never leave the machine. The file is chmod 0600 on
 * POSIX; on Windows it relies on the per-user profile ACL.
 *
 * This is deliberately a file, not an OS keychain binding: a keychain needs native
 * modules per platform and would break the portable desktop build. The trade-off is
 * documented in SECURITY.md — full-disk encryption is the remaining control.
 */
export class SecretVault {
  private cache: Record<string, string> | null = null;

  constructor(private readonly path: string) {}

  private load(): Record<string, string> {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = {};
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      this.cache =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.load(), null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Windows: mode bits are advisory; the user profile ACL is the real control.
    }
  }

  get(ref: string): string | null {
    if (ref.startsWith('env:')) {
      const value = process.env[ref.slice(4)];
      return value === undefined || value === '' ? null : value;
    }
    if (ref.startsWith('vault:')) {
      const value = this.load()[ref.slice(6)];
      return value === undefined || value === '' ? null : value;
    }
    return null;
  }

  set(name: string, value: string): string {
    this.load()[name] = value;
    this.persist();
    return `vault:${name}`;
  }

  delete(name: string): void {
    const current = this.load();
    if (!(name in current)) return;
    delete current[name];
    this.persist();
  }

  /** Only reports whether a ref resolves; never returns the secret itself. */
  has(ref: string): boolean {
    return this.get(ref) !== null;
  }

  names(): string[] {
    return Object.keys(this.load()).sort();
  }
}
