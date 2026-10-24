import type { Approval, Artifact, ArtifactKind, Run, RunEvent, Step } from './entities.js';

export type RunPatch = Partial<
  Pick<Run, 'status' | 'startedAt' | 'endedAt' | 'error' | 'outputRef' | 'inputRef'>
>;

export type StepPatch = Partial<
  Pick<Step, 'status' | 'resultRef' | 'startedAt' | 'endedAt' | 'toolArgs'>
>;

export type BudgetDelta = {
  tokens: number;
  costCny: number;
};

/**
 * Persistence contract consumed by agent-core. Implementations must be
 * transactional per method and must fail closed on constraint violations.
 */
export interface RunStore {
  createRun(run: Run): void;
  getRun(runId: string): Run | null;
  patchRun(runId: string, patch: RunPatch): void;
  addBudgetUsage(runId: string, delta: BudgetDelta): void;

  createStep(step: Step): void;
  patchStep(stepId: string, patch: StepPatch): void;
  listSteps(runId: string): Step[];

  appendEvent(event: RunEvent): void;
  listEvents(runId: string, afterSeq?: number): RunEvent[];
  nextEventSeq(runId: string): number;

  createApproval(approval: Approval): void;
  getApproval(approvalId: string): Approval | null;
  listApprovals(runId: string): Approval[];

  /** Persisted transcript so an interrupted run can resume without replaying the model. */
  appendMessage(message: StoredMessage): void;
  listMessages(runId: string): StoredMessage[];
  /** Marks an approval as consumed; returns false when it was already used. */
  consumeApproval(approvalId: string): boolean;
}

export type StoredMessage = {
  id: string;
  runId: string;
  seq: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId: string | null;
  name: string | null;
  toolCalls: Array<{ id: string; name: string; argumentsJson: string }> | null;
  createdAt: string;
};

export type SaveArtifactInput = {
  id: string;
  projectId: string;
  /** Null when the user saved from the editor with no producing run. */
  runId: string | null;
  kind: ArtifactKind;
  /** Path relative to the project workspace, e.g. `script/script.v2.md`. */
  path: string;
  content: string;
  mime: string;
};

export type ArtifactWithContent = {
  artifact: Artifact;
  content: string;
};

/**
 * Versioned text artifacts. Every save creates a new row; existing rows are
 * immutable so a version can always be reproduced byte for byte.
 */
export interface ArtifactStore {
  save(input: SaveArtifactInput): Artifact;
  read(artifactId: string): ArtifactWithContent | null;
  list(projectId: string): Artifact[];
  latest(projectId: string, kind: ArtifactKind): ArtifactWithContent | null;
  nextVersion(projectId: string, kind: ArtifactKind, baseName: string): number;
}
