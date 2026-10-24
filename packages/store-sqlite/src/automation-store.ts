import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  AutomationSchema,
  type Automation,
  type AutomationInput,
  type AutomationKind,
} from '@creator-studio/protocol';

type AutomationRow = {
  id: string;
  project_id: string;
  name: string;
  kind: string;
  prompt: string;
  interval_minutes: number;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
};

type AutomationRunRow = {
  id: string;
  automation_id: string;
  status: string;
  artifact_id: string | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
};

export type AutomationRun = {
  id: string;
  automationId: string;
  status: 'running' | 'succeeded' | 'failed';
  artifactId: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
};

function toAutomation(row: AutomationRow): Automation {
  return AutomationSchema.parse({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    prompt: row.prompt,
    intervalMinutes: row.interval_minutes,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  });
}

function toRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    status: row.status as AutomationRun['status'],
    artifactId: row.artifact_id,
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export class SqliteAutomationStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: AutomationInput): Automation {
    const createdAt = this.now();
    const automation: Automation = {
      id: randomUUID(),
      projectId: input.projectId,
      name: input.name,
      kind: input.kind,
      prompt: input.prompt,
      intervalMinutes: input.intervalMinutes,
      enabled: input.enabled,
      lastRunAt: null,
      nextRunAt: input.enabled
        ? new Date(createdAt.getTime() + input.intervalMinutes * 60_000).toISOString()
        : null,
      createdAt: createdAt.toISOString(),
    };
    const parsed = AutomationSchema.parse(automation);
    this.db
      .prepare(
        `INSERT INTO automations (id, project_id, name, kind, prompt, interval_minutes, enabled,
           last_run_at, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.projectId,
        parsed.name,
        parsed.kind,
        parsed.prompt,
        parsed.intervalMinutes,
        parsed.enabled ? 1 : 0,
        parsed.lastRunAt,
        parsed.nextRunAt,
        parsed.createdAt,
      );
    return parsed;
  }

  list(projectId?: string): Automation[] {
    const rows = (
      projectId === undefined
        ? this.db.prepare('SELECT * FROM automations ORDER BY created_at DESC').all()
        : this.db.prepare('SELECT * FROM automations WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
    ) as AutomationRow[];
    return rows.map(toAutomation);
  }

  get(id: string): Automation | null {
    const row = this.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as AutomationRow | undefined;
    return row === undefined ? null : toAutomation(row);
  }

  setEnabled(id: string, enabled: boolean): Automation | null {
    const current = this.get(id);
    if (current === null) return null;
    const nextRunAt = enabled
      ? new Date(this.now().getTime() + current.intervalMinutes * 60_000).toISOString()
      : null;
    this.db
      .prepare('UPDATE automations SET enabled = ?, next_run_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, nextRunAt, id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM automations WHERE id = ?').run(id).changes > 0;
  }

  /** Rules whose next run time has passed; the scheduler drains this list. */
  due(at: Date = this.now()): Automation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM automations
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC LIMIT 20`,
      )
      .all(at.toISOString()) as AutomationRow[];
    return rows.map(toAutomation);
  }

  markRun(automationId: string, at: Date = this.now()): void {
    const automation = this.get(automationId);
    if (automation === null) return;
    const next = new Date(at.getTime() + automation.intervalMinutes * 60_000).toISOString();
    this.db
      .prepare('UPDATE automations SET last_run_at = ?, next_run_at = ? WHERE id = ?')
      .run(at.toISOString(), next, automationId);
  }

  startRun(automationId: string): AutomationRun {
    const run: AutomationRun = {
      id: randomUUID(),
      automationId,
      status: 'running',
      artifactId: null,
      error: null,
      startedAt: this.now().toISOString(),
      endedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO automation_runs (id, automation_id, status, artifact_id, error, started_at, ended_at)
         VALUES (?, ?, 'running', NULL, NULL, ?, NULL)`,
      )
      .run(run.id, automationId, run.startedAt);
    return run;
  }

  finishRun(runId: string, result: { ok: true; artifactId: string } | { ok: false; error: string }): void {
    this.db
      .prepare(
        `UPDATE automation_runs SET status = ?, artifact_id = ?, error = ?, ended_at = ? WHERE id = ?`,
      )
      .run(
        result.ok ? 'succeeded' : 'failed',
        result.ok ? result.artifactId : null,
        result.ok ? null : result.error,
        this.now().toISOString(),
        runId,
      );
  }

  listRuns(automationId: string, limit = 20): AutomationRun[] {
    const rows = this.db
      .prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(automationId, limit) as AutomationRunRow[];
    return rows.map(toRun);
  }
}
