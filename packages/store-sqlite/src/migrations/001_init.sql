-- 001_init.sql — 初始 schema，字段与 packages/protocol/src/entities.ts 一一对应
PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  platform         TEXT NOT NULL CHECK (platform IN ('bilibili','youtube','xiaohongshu','generic')),
  stage            TEXT NOT NULL CHECK (stage IN ('topic','research','script','shotlist','package','published','review')),
  workspace_path   TEXT,
  style_profile_id TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX idx_projects_updated ON projects (deleted_at, updated_at DESC);

CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_run_id     TEXT REFERENCES runs(id) ON DELETE SET NULL,
  agent_id          TEXT NOT NULL CHECK (agent_id IN ('producer','scout','researcher','scriptwriter','director','editor','packager','critic')),
  execution_mode    TEXT NOT NULL CHECK (execution_mode IN ('local','hybrid','cloud')),
  status            TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','paused','succeeded','failed','cancelled')),
  model_profile_id  TEXT NOT NULL,
  max_tokens        INTEGER NOT NULL CHECK (max_tokens >= 0),
  max_cost_cny      REAL NOT NULL CHECK (max_cost_cny >= 0),
  used_tokens       INTEGER NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
  used_cost_cny     REAL NOT NULL DEFAULT 0 CHECK (used_cost_cny >= 0),
  input_ref         TEXT,
  output_ref        TEXT,
  error_code        TEXT,
  error_message     TEXT,
  error_retryable   INTEGER CHECK (error_retryable IN (0,1)),
  started_at        TEXT,
  ended_at          TEXT,
  created_at        TEXT NOT NULL,
  CHECK (used_tokens <= max_tokens),
  CHECK (used_cost_cny <= max_cost_cny)
);
CREATE INDEX idx_runs_project ON runs (project_id, created_at DESC);
CREATE INDEX idx_runs_status ON runs (status);

-- INV-1: 同一 Run 最多一个 running Step
CREATE TABLE steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_index  INTEGER NOT NULL CHECK (step_index >= 0),
  kind        TEXT NOT NULL CHECK (kind IN ('model','tool','approval','handoff')),
  status      TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  tool_name   TEXT,
  tool_args   TEXT CHECK (tool_args IS NULL OR json_valid(tool_args)),
  result_ref  TEXT,
  started_at  TEXT,
  ended_at    TEXT,
  UNIQUE (run_id, step_index),
  CHECK (kind <> 'tool' OR tool_name IS NOT NULL)
);
CREATE UNIQUE INDEX uq_steps_one_running ON steps (run_id) WHERE status = 'running';

CREATE TABLE artifacts (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('topic-card','research-notes','script','shot-list','subtitle','publish-pack','review-report','image','audio','other')),
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL CHECK (size >= 0),
  visibility  TEXT NOT NULL CHECK (visibility IN ('local','synced')),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_artifacts_project ON artifacts (project_id, created_at DESC);

CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id      TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('publish','purchase','delete','write-outside-workspace','shell-exec','send-message')),
  payload      TEXT NOT NULL CHECK (json_valid(payload)),
  decision     TEXT NOT NULL CHECK (decision IN ('pending','approved','rejected','expired')),
  requested_at TEXT NOT NULL,
  decided_at   TEXT,
  decided_by   TEXT,
  CHECK (decision = 'pending' OR decided_at IS NOT NULL)
);
CREATE INDEX idx_approvals_decision ON approvals (decision, requested_at DESC);

CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  os           TEXT NOT NULL CHECK (os IN ('windows','macos','linux')),
  public_key   TEXT NOT NULL,
  capabilities TEXT NOT NULL CHECK (json_valid(capabilities)),
  last_seen_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE tool_grants (
  id        TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  tool      TEXT NOT NULL,
  scope     TEXT NOT NULL,
  mode      TEXT NOT NULL CHECK (mode IN ('auto','ask','deny')),
  UNIQUE (device_id, tool, scope)
);

CREATE TABLE model_profiles (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  provider       TEXT NOT NULL CHECK (provider IN ('openai','anthropic','gemini','deepseek','qwen','ollama','openai-compatible')),
  base_url       TEXT NOT NULL,
  model          TEXT NOT NULL,
  api_key_ref    TEXT NOT NULL,
  context_window INTEGER NOT NULL CHECK (context_window > 0),
  price_in_per_m  REAL NOT NULL CHECK (price_in_per_m >= 0),
  price_out_per_m REAL NOT NULL CHECK (price_out_per_m >= 0),
  is_local       INTEGER NOT NULL CHECK (is_local IN (0,1))
);

CREATE TABLE memory_records (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL CHECK (scope IN ('user','project')),
  kind       TEXT NOT NULL CHECK (kind IN ('style','fact','decision','preference')),
  content    TEXT NOT NULL,
  source_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_memory_project ON memory_records (project_id, kind);
CREATE INDEX idx_memory_user ON memory_records (scope) WHERE scope = 'user';

-- INV-9: (run_id, seq) 唯一且连续
CREATE TABLE run_events (
  id      TEXT PRIMARY KEY,
  run_id  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL CHECK (seq >= 0),
  type    TEXT NOT NULL CHECK (type IN ('step.started','step.finished','tool.called','tool.result','approval.requested','budget.warning','run.finished','error')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  ts      TEXT NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE INDEX idx_run_events_run_seq ON run_events (run_id, seq);
