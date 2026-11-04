# Starts an isolated Postgres cluster for the cloud integration suite.
#
# Why a script: apps/cloud/test/postgres.test.ts skips itself when
# CLOUD_TEST_DATABASE_URL is absent. Skipping is right on a machine with no
# database, but a release gate cannot call nine skipped tests "green". This brings
# up a throwaway cluster on a loopback port with its own data directory, so the
# suite actually runs.
#
# Why the runas dance: postgres.exe refuses an elevated token on Windows
# ("Execution of PostgreSQL by a user with administrative permissions is not
# permitted"), and an admin shell is the normal case here. runas /trustlevel:0x20000
# drops to a basic user token.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg-local.ps1
#         then: $env:CLOUD_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55432/postgres'
#               pnpm --filter @creator-studio/cloud test
# Stop:   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pg-local.ps1 -Stop

param(
  [switch]$Stop,
  [int]$Port = 55432
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root '.tmp\pg\node_modules\@embedded-postgres\windows-x64\native\bin'
$data = Join-Path $root '.tmp\pgdata'
$log = Join-Path $root '.tmp\pg.log'

# The cluster binaries are a development-only dependency: they are not in the
# repository (a 60 MB platform binary has no business in git) and not in
# package.json (no runtime path imports them). Fetch them on first use so a fresh
# clone can run the gate with one command instead of failing with homework.
if (-not (Test-Path (Join-Path $bin 'postgres.exe'))) {
  Write-Output 'embedded postgres not found; installing it once into .tmp/pg'
  $installRoot = Join-Path $root '.tmp\pg'
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  # npm needs a manifest to treat this as a project of its own; without one it
  # walks up into the workspace and fails with an internal error.
  $manifest = Join-Path $installRoot 'package.json'
  if (-not (Test-Path $manifest)) {
    '{ "name": "pg-bootstrap", "private": true, "version": "0.0.0" }' | Set-Content -Path $manifest -Encoding utf8
  }
  Push-Location $installRoot
  try {
    npm install --no-save --no-audit --no-fund --loglevel=error embedded-postgres@18.6.0-beta.19
    if ($LASTEXITCODE -ne 0) {
      Write-Error 'could not install embedded-postgres; set CLOUD_TEST_DATABASE_URL to skip this path'
      exit 2
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path (Join-Path $bin 'postgres.exe'))) {
  Write-Error 'embedded postgres installed but postgres.exe is still missing; check the .tmp/pg install'
  exit 2
}

if ($Stop) {
  & runas /trustlevel:0x20000 "`"$bin\pg_ctl.exe`" -D `"$data`" -m immediate stop"
  Start-Sleep -Seconds 2
  # pg_ctl cannot always reach a server started via `cmd /c`; fall back to killing
  # only processes whose executable lives in this project's .tmp directory.
  Get-Process postgres -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like '*creator-studio*.tmp*' } |
    ForEach-Object { Stop-Process -Id $_.Id -Force }
  Start-Sleep -Seconds 1
  Write-Output 'stopped'
  exit 0
}

if (Test-Path $data) {
  Remove-Item -Recurse -Force $data
}
if (Test-Path $log) {
  Remove-Item -Force $log
}

Write-Output "initialising cluster in .tmp\pgdata (port $Port)"
& runas /trustlevel:0x20000 "`"$bin\initdb.exe`" -D `"$data`" -U postgres -A trust -E UTF8"

# runas hands the command off and returns immediately, so poll for the result
# rather than trusting an exit code that never arrives.
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  if (Test-Path (Join-Path $data 'PG_VERSION')) { break }
  Start-Sleep -Milliseconds 500
}
if (-not (Test-Path (Join-Path $data 'PG_VERSION'))) {
  Write-Error 'initdb did not produce PG_VERSION'
  exit 2
}

# A postmaster.pid left by an interrupted run blocks startup with a confusing
# "lock file already exists" error. The cluster is throwaway, so clearing it is safe
# — but only when no server is actually listening on the port.
$pidFile = Join-Path $data 'postmaster.pid'
$listening = (Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded
if ((Test-Path $pidFile) -and -not $listening) {
  Write-Output 'clearing stale postmaster.pid'
  Remove-Item -Force $pidFile
}

Write-Output 'starting cluster'
# Start postgres.exe through `cmd /c` with output redirected. This is the form that
# works under runas: `pg_ctl -o "..."` nests a quoted argument inside an already
# quoted command and the inner quotes are lost, so the server never starts.
& runas /trustlevel:0x20000 "cmd /c `"$bin\postgres.exe`" -D `"$data`" -p $Port -h 127.0.0.1 > `"$log`" 2>&1"

$open = $false
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  $open = (Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded
  if ($open) { break }
  Start-Sleep -Milliseconds 500
}

if (-not $open) {
  Write-Error "cluster did not accept connections on $Port; see .tmp\pg.log"
  exit 2
}

Write-Output "cluster up on 127.0.0.1:$Port"
Write-Output "CLOUD_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:$Port/postgres"
