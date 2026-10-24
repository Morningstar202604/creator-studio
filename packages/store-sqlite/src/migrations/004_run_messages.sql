-- 004: persist the agent transcript so an interrupted run can resume where it stopped.
ALTER TABLE runs ADD COLUMN input_message TEXT;

CREATE TABLE run_messages (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL CHECK (seq >= 0),
  role         TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content      TEXT NOT NULL,
  tool_call_id TEXT,
  name         TEXT,
  tool_calls   TEXT CHECK (tool_calls IS NULL OR json_valid(tool_calls)),
  created_at   TEXT NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE INDEX idx_run_messages_run_seq ON run_messages (run_id, seq);
