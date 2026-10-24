import { z } from 'zod';

const IsoDateTime = z.string().datetime({ offset: false });

const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, 'expected lowercase sha256 hex');

const BaseUrl = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'baseUrl must not embed credentials' });
    }
  });

export const AgentIdSchema = z.enum([
  'producer',
  'scout',
  'researcher',
  'scriptwriter',
  'director',
  'editor',
  'packager',
  'critic',
]);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const ProjectStageSchema = z.enum([
  'topic',
  'research',
  'script',
  'shotlist',
  'package',
  'published',
  'review',
]);
export type ProjectStage = z.infer<typeof ProjectStageSchema>;

export const PlatformSchema = z.enum(['bilibili', 'youtube', 'xiaohongshu', 'generic']);
export type Platform = z.infer<typeof PlatformSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  title: z.string().min(1).max(200),
  platform: PlatformSchema,
  stage: ProjectStageSchema,
  workspacePath: z.string().min(1).nullable(),
  styleProfileId: z.string().min(1).nullable(),
  description: z.string().max(500).default(''),
  tags: z.array(z.string().min(1).max(24)).max(12).default([]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: IsoDateTime.nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ExecutionModeSchema = z.enum(['local', 'hybrid', 'cloud']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const BudgetSchema = z.object({
  maxTokens: z.number().int().nonnegative(),
  maxCostCny: z.number().nonnegative(),
  usedTokens: z.number().int().nonnegative(),
  usedCostCny: z.number().nonnegative(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const RunErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});
export type RunError = z.infer<typeof RunErrorSchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  parentRunId: z.string().min(1).nullable(),
  agentId: AgentIdSchema,
  executionMode: ExecutionModeSchema,
  status: RunStatusSchema,
  modelProfileId: z.string().min(1),
  budget: BudgetSchema,
  inputRef: z.string().min(1).nullable(),
  outputRef: z.string().min(1).nullable(),
  error: RunErrorSchema.nullable(),
  startedAt: IsoDateTime.nullable(),
  endedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type Run = z.infer<typeof RunSchema>;

export const StepKindSchema = z.enum(['model', 'tool', 'approval', 'handoff']);
export type StepKind = z.infer<typeof StepKindSchema>;

export const StepStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const StepSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    index: z.number().int().nonnegative(),
    kind: StepKindSchema,
    status: StepStatusSchema,
    toolName: z.string().min(1).nullable(),
    toolArgs: z.unknown().nullable(),
    resultRef: z.string().min(1).nullable(),
    startedAt: IsoDateTime.nullable(),
    endedAt: IsoDateTime.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'tool' && value.toolName === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool step requires toolName', path: ['toolName'] });
    }
    if (value.status === 'running' && value.startedAt === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'running step requires startedAt', path: ['startedAt'] });
    }
  });
export type Step = z.infer<typeof StepSchema>;

export const ArtifactKindSchema = z.enum([
  'topic-card',
  'research-notes',
  'script',
  'shot-list',
  'subtitle',
  'publish-pack',
  'review-report',
  'image',
  'audio',
  'other',
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  /** Null when the artifact was authored manually rather than produced by a run. */
  runId: z.string().min(1).nullable(),
  kind: ArtifactKindSchema,
  path: z.string().min(1),
  sha256: Sha256Hex,
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  visibility: z.enum(['local', 'synced']),
  createdAt: IsoDateTime,
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ApprovalKindSchema = z.enum([
  'publish',
  'purchase',
  'delete',
  'write-outside-workspace',
  'shell-exec',
  'send-message',
]);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  kind: ApprovalKindSchema,
  payload: z.unknown(),
  decision: z.enum(['pending', 'approved', 'rejected', 'expired']),
  requestedAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
  decidedBy: z.string().min(1).nullable(),
  consumedAt: IsoDateTime.nullable().default(null),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ToolCapabilitySchema = z.string().min(1);
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

export const DeviceSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1),
  os: z.enum(['windows', 'macos', 'linux']),
  publicKey: z.string().min(1),
  capabilities: z.array(ToolCapabilitySchema),
  lastSeenAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const GrantModeSchema = z.enum(['auto', 'ask', 'deny']);
export type GrantMode = z.infer<typeof GrantModeSchema>;

export const ToolGrantSchema = z.object({
  id: z.string().min(1),
  deviceId: z.string().min(1),
  tool: z.string().min(1),
  scope: z.string().min(1),
  mode: GrantModeSchema,
});
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

export const ProviderSchema = z.enum([
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'qwen',
  'ollama',
  'openai-compatible',
]);
export type Provider = z.infer<typeof ProviderSchema>;

export const ModelProfileSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().min(1),
  provider: ProviderSchema,
  baseUrl: BaseUrl,
  model: z.string().min(1),
  apiKeyRef: z.string().min(1),
  contextWindow: z.number().int().positive(),
  priceInPerM: z.number().nonnegative(),
  priceOutPerM: z.number().nonnegative(),
  isLocal: z.boolean(),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const MemoryRecordSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  scope: z.enum(['user', 'project']),
  kind: z.enum(['style', 'fact', 'decision', 'preference']),
  content: z.string().min(1),
  embedding: z.array(z.number()).nullable(),
  sourceRef: z.string().min(1).nullable(),
  createdAt: IsoDateTime,
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const RunEventTypeSchema = z.enum([
  'step.started',
  'step.finished',
  'tool.called',
  'tool.result',
  'approval.requested',
  'budget.warning',
  'run.finished',
  'error',
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const RunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  type: RunEventTypeSchema,
  payload: z.unknown(),
  ts: IsoDateTime,
});
export type RunEvent = z.infer<typeof RunEventSchema>;
