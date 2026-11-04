import type { Approval } from '@creator-studio/protocol';
import { MemoryAuditSink, nextAuditId, type AuditRecord, type AuditSink } from './audit.js';
import { evaluateGrant } from './grants.js';
import { PathEscapeError, resolveInsideWorkspace, toWorkspaceRelative } from './path.js';
import {
  ToolError,
  type ToolAnnotations,
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

  /**
   * Tool catalogue for `/v1/tools`.
   *
   * `annotations` is passed through verbatim, using MCP's vocabulary, so a client
   * (or another agent runtime) can tell which calls are safe to batch without
   * knowing anything about this codebase.
   */
  list(): Array<{
    name: string;
    risk: string;
    approvalKind: string | null;
    annotations?: ToolAnnotations;
  }> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      risk: tool.risk,
      approvalKind: tool.approvalKind,
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
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
    let resolvedTarget: string | null = null;
    try {
      target = tool.pathArg !== undefined ? extractPath(input, tool.pathArg) : extractTarget(input);
    } catch (error) {
      record('allow', 'INVALID_INPUT', false, 'INVALID_INPUT');
      const message = error instanceof Error ? error.message : 'invalid input';
      return fail('INVALID_INPUT', message, started);
    }

    if (tool.pathArg !== undefined) {
      try {
        // Keep the resolved absolute path: the tool must execute against the path
        // that was actually validated, not re-join the caller's string. Discarding
        // this result was how a dangling symlink inside the workspace could point
        // outside it — validation saw the link's parent, execution followed the link.
        resolvedTarget = resolveInsideWorkspace(target, {
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

    // Match grants against the *resolved* target, never the caller's string.
    // `assets/../secret/x.md` and `./secret/x.md` are the same file, so a rule that
    // denies `secret/**` must see the same path the filesystem will. Without this,
    // any scoped rule can be walked around by an equivalent path spelling.
    const grantTarget =
      resolvedTarget === null
        ? target
        : toWorkspaceRelative(resolvedTarget, this.options.workspaceRoot, this.options.platform);
    const grantDecision = evaluateGrant({
      grants: context.grants,
      deviceId: context.deviceId,
      tool: name,
      target: grantTarget,
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
      // An approval is consent for *this* call, not a licence for its category. The
      // prompt shows the user a target; if the executed target differs, the consent
      // was for something else. Both the tool name and the normalised target are
      // compared, and the payload (which holds the arguments the user was shown) must
      // match the arguments about to be used.
      const toolMatches = approval === null || approval.payload === null || approval.payload === undefined
        ? approval !== null && approval.decision === 'approved' && approval.kind === tool.approvalKind
        : approvalMatchesCall(approval.payload, name, resolvedTarget ?? target);
      if (approval === null || approval.decision !== 'approved' || !kindMatches || !runMatches || !toolMatches) {
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
      // The tool keeps receiving the caller's original input: rewriting it would
      // change the contract every tool and every test relies on. Instead the resolved
      // path is exposed on the context, so a tool that wants the safe absolute path
      // can use it, and `fs.*` in this repository does.
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

/**
 * Whether an approval's recorded payload authorises this exact tool and target.
 *
 * The approval payload is whatever the caller recorded when asking — for the agent
 * loop that is the tool's input object. We compare the tool name (when present) and
 * the path/url the user saw. A payload we cannot interpret is treated as
 * authorising nothing, because guessing here is what allows target substitution.
 */
function approvalMatchesCall(payload: unknown, toolName: string, target: string): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const record = payload as Record<string, unknown>;

  // Some callers record `{ tool, target }`, others record the raw input. Accept both,
  // but require the tool to match when the payload states it.
  if (typeof record['tool'] === 'string' && record['tool'] !== toolName) return false;

  const candidateRecord =
    typeof record['target'] === 'string'
      ? { value: record['target'], kind: 'target' as const }
      : typeof record['path'] === 'string'
        ? { value: record['path'], kind: 'path' as const }
        : typeof record['url'] === 'string'
          ? { value: record['url'], kind: 'url' as const }
          : null;

  if (candidateRecord === null) {
    // No target in the payload means the approval was for a call with no target
    // (e.g. a tool that takes only text). Only allow it when this call also has no
    // distinguishable target.
    return target === '' || target === undefined;
  }

  // The approval records whatever the caller passed in — often a workspace-relative
  // path, while `target` here is the resolved absolute path. Compare the tail rather
  // than requiring identical strings: an approval for `a.md` authorises the call
  // whose resolved target ends in `/a.md`, and nothing else.
  const approved = normalizeForCompare(candidateRecord.value);
  const actual = normalizeForCompare(target);
  if (approved === actual) return true;
  if (candidateRecord.kind !== 'path') return false;
  return actual.endsWith(`/${approved.replace(/^\.\//, '')}`);
}

/** Path and URL comparison that ignores case and separator style on Windows paths. */
function normalizeForCompare(value: string): string {
  const unified = value.split(String.fromCharCode(92)).join('/').replace(/\/{2,}/g, '/');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
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
