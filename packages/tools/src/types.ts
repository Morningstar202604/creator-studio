import type { Approval, ApprovalKind, ToolGrant } from '@creator-studio/protocol';


export type ToolRisk = 'low' | 'medium' | 'high';

export type ToolDefinition<Input = unknown, Output = unknown> = {
  name: string;
  risk: ToolRisk;
  approvalKind: ApprovalKind | null;
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
