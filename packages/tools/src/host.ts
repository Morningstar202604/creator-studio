import type { Approval } from '@creator-studio/protocol';
import { MemoryAuditSink, nextAuditId, type AuditRecord, type AuditSink } from './audit.js';
import { evaluateGrant } from './grants.js';
import { PathEscapeError, resolveInsideWorkspace } from './path.js';
import {
  ToolError,
  type ToolCallContext,
  type ToolCallResult,
  type ToolDefinition,
  type ToolErrorCode,
} from './types.js';

export type ToolHostOptions = {
  workspaceRoot: string;
  audit?: AuditSink;
  /** Approval ids already spent; guards against replaying one approval twice. */
  consumedApprovalIds?: Set<string>;
  defaultTimeoutMs?: number;
  platform?: NodeJS.Platform;
  realpath?: (path: string) => string;
};

export type ExecuteOptions = {
  name: string;
  input: unknown;
  context: ToolCallContext;
};

const HIGH_RISK_KINDS = new Set<string>(['delete', 'shell-exec', 'publish', 'purchase', 'write-outside-workspace', 'send-message']);

export class ToolHost {
  private readonly tools = new Map<string, ToolDefinition<never, unknown>>();
  private readonly audit: AuditSink;
  private readonly consumed: Set<string>;
  private readonly timeoutMs: number;

  constructor(private readonly options: ToolHostOptions) {
    this.audit = options.audit ?? new MemoryAuditSink();
    this.consumed = options.consumedApprovalIds ?? new Set<string>();
    this.timeoutMs = options.defaultTimeoutMs ?? 60_000;
  }

  register<I, O>(definition: ToolDefinition<I, O>): void {
    this.tools.set(definition.name, definition as unknown as ToolDefinition<never, unknown>);
  }

  list(): Array<{ name: string; risk: string; approvalKind: string | null }> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      risk: tool.risk,
      approvalKind: tool.approvalKind,
    }));
  }

  async execute<O = unknown>({ name, input, context }: ExecuteOptions): Promise<ToolCallResult<O>> {
    const started = Date.now();
    const tool = this.tools.get(name);

    const record = (decision: AuditRecord['decision'], reason: string, ok: boolean, errorCode: string | null): void => {
      void this.audit.write({
        id: nextAuditId(),
        ts: new Date().toISOString(),
        deviceId: context.deviceId,
        runId: context.runId,
        tool: name,
        target: extractTarget(input),
        decision,
        reason,
        durationMs: Date.now() - started,
        ok,
        errorCode,
      });
    };

    if (tool === undefined) {
      record('deny', 'TOOL_NOT_FOUND', false, 'TOOL_NOT_FOUND');
      return fail('TOOL_NOT_FOUND', `unknown tool ${name}`, started);
    }

    let target: string;
    try {
      target = tool.pathArg !== undefined ? extractPath(input, tool.pathArg) : extractTarget(input);
    } catch (error) {
      record('allow', 'INVALID_INPUT', false, 'INVALID_INPUT');
      const message = error instanceof Error ? error.message : 'invalid input';
      return fail('INVALID_INPUT', message, started);
    }

    if (tool.pathArg !== undefined) {
      try {
        resolveInsideWorkspace(target, {
          workspaceRoot: this.options.workspaceRoot,
          ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
          ...(this.options.realpath === undefined ? {} : { realpath: this.options.realpath }),
        });
      } catch (error) {
        if (error instanceof PathEscapeError) {
          record('deny', 'PATH_ESCAPE', false, 'PATH_ESCAPE');
          return fail('PATH_ESCAPE', error.message, started);
        }
        throw error;
      }
    }

    const grantDecision = evaluateGrant({
      grants: context.grants,
      deviceId: context.deviceId,
      tool: name,
      target,
    });

    if (grantDecision.decision === 'deny') {
      record('deny', grantDecision.reason, false, grantDecision.reason);
      return fail(grantDecision.reason === 'NO_GRANT' ? 'NO_GRANT' : 'DENIED_BY_RULE', `grant ${grantDecision.reason}`, started);
    }

    const needsApproval = grantDecision.decision === 'ask' || (tool.approvalKind !== null && tool.risk === 'high');
    if (needsApproval) {
      const approval = context.approval;
      const kindMatches = tool.approvalKind === null || (approval !== null && approval.kind === tool.approvalKind);
      const runMatches = approval === null || context.runId === null || approval.runId === context.runId;
      if (approval === null || approval.decision !== 'approved' || !kindMatches || !runMatches) {
        record('deny', 'APPROVAL_REQUIRED', false, 'APPROVAL_REQUIRED');
        const wanted = tool.approvalKind ?? 'an explicit';
        return fail('APPROVAL_REQUIRED', `tool ${name} requires ${wanted} approval`, started);
      }
      if (this.consumed.has(approval.id)) {
        record('deny', 'APPROVAL_CONSUMED', false, 'APPROVAL_CONSUMED');
        return fail('APPROVAL_CONSUMED', `approval ${approval.id} was already used`, started);
      }
      this.consumed.add(approval.id);
    }

    let parsed: never;
    try {
      parsed = tool.inputSchema(input);
    } catch (error) {
      record('allow', 'INVALID_INPUT', false, 'INVALID_INPUT');
      const message = error instanceof Error ? error.message : 'invalid input';
      return fail('INVALID_INPUT', message, started);
    }

    try {
      const output = await withTimeout(
        tool.execute(parsed),
        this.timeoutMs,
        context.signal,
      );
      record(grantDecision.decision === 'ask' ? 'ask' : 'allow', grantDecision.reason, true, null);
      return { ok: true, output: output as O, durationMs: Date.now() - started };
    } catch (error) {
      if (error instanceof ToolError) {
        record('allow', 'EXECUTION_ERROR', false, error.code);
        return fail(error.code, error.message, started);
      }
      const message = error instanceof Error ? error.message : 'execution failed';
      record('allow', 'EXECUTION_ERROR', false, 'EXECUTION_FAILED');
      return fail('EXECUTION_FAILED', message, started);
    }
  }

  auditRecords(): AuditRecord[] {
    return this.audit.all();
  }
}

function fail<O>(code: ToolErrorCode, message: string, started: number): ToolCallResult<O> {
  return { ok: false, code, message, durationMs: Date.now() - started };
}

function extractPath(input: unknown, key: string): string {
  if (typeof input !== 'object' || input === null) throw new ToolError('INVALID_INPUT', 'input must be an object');
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== 'string') throw new ToolError('INVALID_INPUT', `missing path argument ${key}`);
  return value;
}

function extractTarget(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  const candidate = record.path ?? record.target ?? record.url ?? record.command;
  return typeof candidate === 'string' ? candidate : '';
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ToolError('TIMEOUT', `tool exceeded ${ms}ms`));
    }, ms);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ToolError('TIMEOUT', 'tool aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function approvedBy(approval: Approval | null): boolean {
  return approval !== null && approval.decision === 'approved' && HIGH_RISK_KINDS.has(approval.kind);
}
