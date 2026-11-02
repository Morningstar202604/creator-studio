#!/usr/bin/env node
/**
 * Runs the Postgres integration suite against a real database.
 *
 * Two modes, and both refuse to report a pass they did not earn:
 *
 *   CLOUD_TEST_DATABASE_URL set  → run against that database.
 *   not set                      → start a throwaway cluster (scripts/pg-local.ps1
 *                                  on Windows), run against it, tear it down.
 *
 * A third outcome exists on purpose: if a cluster cannot be started, this exits 2
 * with NOT_ENABLED. That is not "green" — `pnpm verify` treats it as a failure,
 * because nine tests that never ran are not nine tests that passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const cloudDirectory = fileURLToPath(new URL('../apps/cloud/', import.meta.url));
const pgLocal = fileURLToPath(new URL('./pg-local.ps1', import.meta.url));
const localPort = process.env['CS_PG_PORT'] ?? '55432';
const localUrl = `postgres://postgres@127.0.0.1:${localPort}/postgres`;

let databaseUrl = process.env['CLOUD_TEST_DATABASE_URL'] ?? '';
let startedLocal = false;

if (databaseUrl === '') {
  if (process.platform !== 'win32') {
    console.error('NOT_ENABLED: set CLOUD_TEST_DATABASE_URL to an isolated test database.');
    console.error('A throwaway cluster is only automated on Windows (scripts/pg-local.ps1).');
    process.exit(2);
  }
  console.error('no CLOUD_TEST_DATABASE_URL; starting a throwaway cluster');
  const up = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', pgLocal], {
    stdio: 'inherit',
  });
  if (up.status !== 0) {
    console.error('NOT_ENABLED: could not start a local cluster; set CLOUD_TEST_DATABASE_URL to run this suite.');
    process.exit(2);
  }
  databaseUrl = localUrl;
  startedLocal = true;
}

const require = createRequire(new URL('../apps/cloud/package.json', import.meta.url));
const vitest = require.resolve('vitest/vitest.mjs');

const suite = spawn(process.execPath, [vitest, 'run', 'test/postgres.test.ts', '--reporter=verbose'], {
  cwd: cloudDirectory,
  env: { ...process.env, CLOUD_TEST_DATABASE_URL: databaseUrl },
  stdio: 'inherit',
  shell: false,
});

const code = await new Promise((resolve) => suite.on('exit', resolve));

if (startedLocal) {
  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', pgLocal, '-Stop'], {
    stdio: 'inherit',
  });
}

process.exit(code ?? 1);
