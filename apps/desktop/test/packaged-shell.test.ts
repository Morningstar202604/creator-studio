import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const libRs = readFileSync(join(root, 'apps/desktop/src-tauri/src/lib.rs'), 'utf8');
const staging = readFileSync(join(root, 'scripts/install-daemon-deps.mjs'), 'utf8');
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');

describe('R9 the packaged shell starts on a clean machine', () => {
  it('ships a Node runtime instead of depending on the user PATH', () => {
    // The staging script bundles the running node binary; the shell prefers it.
    expect(staging).toContain('process.execPath');
    expect(libRs).toContain('bundled_node');
    expect(libRs).toMatch(/daemon-runtime["')]+\.join\("node/);
    // The staged binary is a build artifact, never a committed file.
    expect(gitignore).toContain('daemon-runtime/node.exe');
  });

  it('does not drop a console window over the app', () => {
    // node is console-subsystem; without CREATE_NO_WINDOW the child allocates
    // its own black window on top of the interface.
    expect(libRs).toContain('CREATE_NO_WINDOW');
    expect(libRs).toContain('creation_flags');
  });
});
