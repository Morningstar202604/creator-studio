-- 006: approvals are single-use; a resumed run consumes the approval it executes.
ALTER TABLE approvals ADD COLUMN consumed_at TEXT;
CREATE INDEX idx_approvals_open ON approvals (run_id, decision, consumed_at);
