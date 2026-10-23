import type { Database } from 'better-sqlite3';
import {
  ApprovalSchema,
  RunEventSchema,
  RunSchema,
  StepSchema,
  assertNextRunEventSeq,
  type Approval,
  type BudgetDelta,
  type Run,
  type RunEvent,
  type RunPatch,
  type RunStore,
  type Step,
  type StepPatch,
} from '@creator-studio/protocol';

type RunRow = {
  id: string;
  project_id: string;
  parent_run_id: string | null;
  agent_id: string;
  execution_mode: string;
  status: string;
  model_profile_id: string;
  max_tokens: number;
  max_cost_cny: number;
  used_tokens: number;
  used_cost_cny: number;
  input_ref: string | null;
  output_ref: string | null;
  error_code: string | null;
  error_message: string | null;
  error_retryable: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
};

type StepRow = {
  id: string;
  run_id: string;
  step_index: number;
  kind: string;
  status: string;
  tool_name: string | null;
  tool_args: string | null;
  result_ref: string | null;
  started_at: string | null;
  ended_at: string | null;
};

type EventRow = {
  id: string;
  run_id: string;
  seq: number;
  type: string;
  payload: string;
  ts: string;
};

type ApprovalRow = {
  id: string;
  run_id: string;
  step_id: string;
  kind: string;
  payload: string;
  decision: string;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

function toRun(row: RunRow): Run {
  return RunSchema.parse({
    id: row.id,
    projectId: row.project_id,
    parentRunId: row.parent_run_id,
    agentId: row.agent_id,
    executionMode: row.execution_mode,
    status: row.status,
    modelProfileId: row.model_profile_id,
    budget: {
      maxTokens: row.max_tokens,
      maxCostCny: row.max_cost_cny,
      usedTokens: row.used_tokens,
      usedCostCny: row.used_cost_cny,
    },
    inputRef: row.input_ref,
    outputRef: row.output_ref,
    error:
      row.error_code === null
        ? null
        : {
            code: row.error_code,
            message: row.error_message ?? '',
            retryable: row.error_retryable === 1,
          },
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  });
}

function toStep(row: StepRow): Step {
  return StepSchema.parse({
    id: row.id,
    runId: row.run_id,
    index: row.step_index,
    kind: row.kind,
    status: row.status,
    toolName: row.tool_name,
    toolArgs: row.tool_args === null ? null : (JSON.parse(row.tool_args) as unknown),
    resultRef: row.result_ref,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  });
}

function toEvent(row: EventRow): RunEvent {
  return RunEventSchema.parse({
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    type: row.type,
    payload: JSON.parse(row.payload) as unknown,
    ts: row.ts,
  });
}

function toApproval(row: ApprovalRow): Approval {
  return ApprovalSchema.parse({
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as unknown,
    decision: row.decision,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  });
}

export class SqliteRunStore implements RunStore {
  constructor(private readonly db: Database) {}

  createRun(run: Run): void {
    const parsed = RunSchema.parse(run);
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, parent_run_id, agent_id, execution_mode, status,
           model_profile_id, max_tokens, max_cost_cny, used_tokens, used_cost_cny,
           input_ref, output_ref, error_code, error_message, error_retryable,
           started_at, ended_at, created_at)
         VALUES (@id, @project_id, @parent_run_id, @agent_id, @execution_mode, @status,
           @model_profile_id, @max_tokens, @max_cost_cny, @used_tokens, @used_cost_cny,
           @input_ref, @output_ref, @error_code, @error_message, @error_retryable,
           @started_at, @ended_at, @created_at)`,
      )
      .run({
        id: parsed.id,
        project_id: parsed.projectId,
        parent_run_id: parsed.parentRunId,
        agent_id: parsed.agentId,
        execution_mode: parsed.executionMode,
        status: parsed.status,
        model_profile_id: parsed.modelProfileId,
        max_tokens: parsed.budget.maxTokens,
        max_cost_cny: parsed.budget.maxCostCny,
        used_tokens: parsed.budget.usedTokens,
        used_cost_cny: parsed.budget.usedCostCny,
        input_ref: parsed.inputRef,
        output_ref: parsed.outputRef,
        error_code: parsed.error?.code ?? null,
        error_message: parsed.error?.message ?? null,
        error_retryable: parsed.error === null ? null : parsed.error.retryable ? 1 : 0,
        started_at: parsed.startedAt,
        ended_at: parsed.endedAt,
        created_at: parsed.createdAt,
      });
  }

  getRun(runId: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
    return row === undefined ? null : toRun(row);
  }

  patchRun(runId: string, patch: RunPatch): void {
    const sets: string[] = [];
    const values: Record<string, unknown> = { id: runId };

    if (patch.status !== undefined) {
      sets.push('status = @status');
      values.status = patch.status;
    }
    if (patch.startedAt !== undefined) {
      sets.push('started_at = @started_at');
      values.started_at = patch.startedAt;
    }
    if (patch.endedAt !== undefined) {
      sets.push('ended_at = @ended_at');
      values.ended_at = patch.endedAt;
    }
    if (patch.outputRef !== undefined) {
      sets.push('output_ref = @output_ref');
      values.output_ref = patch.outputRef;
    }
    if (patch.inputRef !== undefined) {
      sets.push('input_ref = @input_ref');
      values.input_ref = patch.inputRef;
    }
    if (patch.error !== undefined) {
      sets.push('error_code = @error_code, error_message = @error_message, error_retryable = @error_retryable');
      values.error_code = patch.error?.code ?? null;
      values.error_message = patch.error?.message ?? null;
      values.error_retryable = patch.error === null ? null : patch.error.retryable ? 1 : 0;
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = @id`).run(values);
  }

  addBudgetUsage(runId: string, delta: BudgetDelta): void {
    const result = this.db
      .prepare(
        `UPDATE runs SET used_tokens = used_tokens + @tokens, used_cost_cny = used_cost_cny + @cost
         WHERE id = @id AND used_tokens + @tokens <= max_tokens AND used_cost_cny + @cost <= max_cost_cny`,
      )
      .run({ id: runId, tokens: delta.tokens, cost: delta.costCny });
    if (result.changes === 0) {
      throw new Error('BUDGET_EXCEEDED');
    }
  }

  createStep(step: Step): void {
    const parsed = StepSchema.parse(step);
    this.db
      .prepare(
        `INSERT INTO steps (id, run_id, step_index, kind, status, tool_name, tool_args, result_ref, started_at, ended_at)
         VALUES (@id, @run_id, @step_index, @kind, @status, @tool_name, @tool_args, @result_ref, @started_at, @ended_at)`,
      )
      .run({
        id: parsed.id,
        run_id: parsed.runId,
        step_index: parsed.index,
        kind: parsed.kind,
        status: parsed.status,
        tool_name: parsed.toolName,
        tool_args: parsed.toolArgs === null ? null : JSON.stringify(parsed.toolArgs),
        result_ref: parsed.resultRef,
        started_at: parsed.startedAt,
        ended_at: parsed.endedAt,
      });
  }

  patchStep(stepId: string, patch: StepPatch): void {
    const sets: string[] = [];
    const values: Record<string, unknown> = { id: stepId };

    if (patch.status !== undefined) {
      sets.push('status = @status');
      values.status = patch.status;
    }
    if (patch.startedAt !== undefined) {
      sets.push('started_at = @started_at');
      values.started_at = patch.startedAt;
    }
    if (patch.endedAt !== undefined) {
      sets.push('ended_at = @ended_at');
      values.ended_at = patch.endedAt;
    }
    if (patch.resultRef !== undefined) {
      sets.push('result_ref = @result_ref');
      values.result_ref = patch.resultRef;
    }
    if (patch.toolArgs !== undefined) {
      sets.push('tool_args = @tool_args');
      values.tool_args = patch.toolArgs === null ? null : JSON.stringify(patch.toolArgs);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE steps SET ${sets.join(', ')} WHERE id = @id`).run(values);
  }

  listSteps(runId: string): Step[] {
    const rows = this.db
      .prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY step_index ASC')
      .all(runId) as StepRow[];
    return rows.map(toStep);
  }

  appendEvent(event: RunEvent): void {
    const parsed = RunEventSchema.parse(event);
    const previous = this.nextEventSeq(parsed.runId) - 1;
    assertNextRunEventSeq(previous < 0 ? null : previous, parsed.seq);
    this.db
      .prepare('INSERT INTO run_events (id, run_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(parsed.id, parsed.runId, parsed.seq, parsed.type, JSON.stringify(parsed.payload), parsed.ts);
  }

  listEvents(runId: string, afterSeq = -1): RunEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC')
      .all(runId, afterSeq) as EventRow[];
    return rows.map(toEvent);
  }

  nextEventSeq(runId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) AS last FROM run_events WHERE run_id = ?')
      .get(runId) as { last: number };
    return row.last + 1;
  }

  createApproval(approval: Approval): void {
    const parsed = ApprovalSchema.parse(approval);
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, step_id, kind, payload, decision, requested_at, decided_at, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.runId,
        parsed.stepId,
        parsed.kind,
        JSON.stringify(parsed.payload),
        parsed.decision,
        parsed.requestedAt,
        parsed.decidedAt,
        parsed.decidedBy,
      );
  }

  getApproval(approvalId: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as ApprovalRow | undefined;
    return row === undefined ? null : toApproval(row);
  }

  listApprovals(runId: string): Approval[] {
    const rows = this.db
      .prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY requested_at ASC')
      .all(runId) as ApprovalRow[];
    return rows.map(toApproval);
  }
}
