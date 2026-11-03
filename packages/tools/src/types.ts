import type { Approval, ApprovalKind, ToolGrant } from '@creator-studio/protocol';


export type ToolRisk = 'low' | 'medium' | 'high';

/**
 * Behavioral hints for a tool, mirroring MCP's `ToolAnnotations`.
 *
 * They exist so a client (or a model) can decide how careful to be before calling:
 * a read-only tool needs no confirmation dialog, a destructive one always does.
 * They are hints, not enforcement — the enforcement is `risk` plus the approval
 * gate — but they are the vocabulary other agent runtimes already understand.
 */
export type ToolAnnotations = {
  /** Human-readable title, for UIs that show tools by name only. */
  title?: string;
  /** True when the tool does not modify anything. Default false. */
  readOnlyHint?: boolean;
  /** True when the tool may remove or overwrite. Meaningful only when not read-only. */
  destructiveHint?: boolean;
  /** True when repeating the same call has no additional effect. */
  idempotentHint?: boolean;
  /** True when the tool reaches an external system (network, another process). */
  openWorldHint?: boolean;
};

export type ToolDefinition<Input = unknown, Output = unknown> = {
  name: string;
  risk: ToolRisk;
  approvalKind: ApprovalKind | null;
  /**
   * MCP-compatible hints. Optional so existing tools keep working, but every
   * built-in tool declares them — an agent runtime reading /v1/tools can then
   * tell which calls are safe to batch.
   */
  annotations?: ToolAnnotations;
  /** Path argument used for workspace sandboxing, when the tool touches files. */
  pathArg?: keyof Input & string;
  inputSchema: (input: unknown) => Input;
  execute: (input: Input) => Promise<Output>;
};

export type ToolCallContext = {
  deviceId: string;
  runId: string | null;
  workspaceRoot: string;
  grants: ToolGrant[];
  approval: Approval | null;
  signal?: AbortSignal | undefined;
};

export type ToolCallResult<Output = unknown> =
  | { ok: true; output: Output; durationMs: number }
  | { ok: false; code: ToolErrorCode; message: string; durationMs: number };

export type ToolErrorCode =
  | 'NO_GRANT'
  | 'DENIED_BY_RULE'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_CONSUMED'
  | 'PATH_ESCAPE'
  | 'TOOL_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'TIMEOUT'
  | 'EXECUTION_FAILED';

export class ToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ToolError';
    this.code = code;
  }
}
