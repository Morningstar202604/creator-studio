-- 008: reusable style profiles (tone / audience / banned words / notes).
-- Projects already carry a style_profile_id column (001); this migration adds the
-- rows it points at and keeps deletion honest via ON DELETE SET NULL semantics
-- applied in SqliteStyleStore.delete (SQLite cannot add an FK after the fact
-- without rebuilding the table, so the store owns that invariant).
CREATE TABLE style_profiles (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  tone         TEXT NOT NULL DEFAULT '',
  audience     TEXT NOT NULL DEFAULT '',
  banned_words TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(banned_words)),
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_style_profiles_user ON style_profiles (user_id, updated_at DESC);
CREATE INDEX idx_projects_style ON projects (style_profile_id);
