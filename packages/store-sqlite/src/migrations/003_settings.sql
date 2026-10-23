-- 003: user-level settings and model profiles become editable at runtime.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_model_profiles_user ON model_profiles (user_id);
CREATE INDEX idx_tool_grants_device ON tool_grants (device_id);
