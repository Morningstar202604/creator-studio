import type { Approval, ApprovalKind, Budget, Step } from './entities.js';
import { DomainError } from './errors.js';

export type StepStartCheck = { ok: true } | { ok: false; code: 'RUN_ALREADY_HAS_RUNNING_STEP' };

const DESTRUCTIVE_TOOLS = new Set<ApprovalKind>([
  'publish',
  'purchase',
  'delete',
  'write-outside-workspace',
  'shell-exec',
  'send-message',
]);

const APPROVAL_KINDS = new Set<string>([
  'publish',
  'purchase',
  'delete',
  'write-outside-workspace',
  'shell-exec',
  'send-message',
]);

export function isApprovalKind(value: string): value is ApprovalKind {
  return APPROVAL_KINDS.has(value);
}

export function requiresApproval(kind: string): boolean {
  return isApprovalKind(kind) && DESTRUCTIVE_TOOLS.has(kind);
}

export function assertApproved(kind: ApprovalKind, approval: Approval | null): void {
  if (approval === null) {
    throw new DomainError('APPROVAL_REQUIRED', `no approval supplied for ${kind}`);
  }
  if (approval.decision !== 'approved') {
    throw new DomainError('APPROVAL_REQUIRED', `approval ${approval.id} is ${approval.decision}`);
  }
  if (approval.kind !== kind) {
    throw new DomainError('APPROVAL_REQUIRED', `approval ${approval.id} covers ${approval.kind}, not ${kind}`);
  }
}

export function canStartStep(steps: Step[]): StepStartCheck {
  const running = steps.filter((step) => step.status === 'running');
  if (running.length > 0) return { ok: false, code: 'RUN_ALREADY_HAS_RUNNING_STEP' };
  return { ok: true };
}

export type Estimate = { tokens: number; costCny: number };

export function assertBudget(budget: Budget, estimate: Estimate): void {
  const { tokens, costCny } = estimate;
  if (!Number.isFinite(tokens) || !Number.isFinite(costCny)) {
    throw new DomainError('BUDGET_EXCEEDED', 'non-finite estimate');
  }
  if (tokens < 0 || costCny < 0) {
    throw new DomainError('BUDGET_EXCEEDED', 'negative estimate');
  }
  if (budget.usedTokens + tokens > budget.maxTokens) {
    throw new DomainError('BUDGET_EXCEEDED', `tokens ${budget.usedTokens}+${tokens} > ${budget.maxTokens}`);
  }
  if (budget.usedCostCny + costCny > budget.maxCostCny) {
    throw new DomainError(
      'BUDGET_EXCEEDED',
      `cost ${budget.usedCostCny}+${costCny} > ${budget.maxCostCny}`,
    );
  }
}

export function assertNextRunEventSeq(previousSeq: number | null, nextSeq: number): void {
  const expected = previousSeq === null ? 0 : previousSeq + 1;
  if (nextSeq !== expected) {
    throw new DomainError('INVALID_TRANSITION', `event seq must be ${expected}, got ${nextSeq}`);
  }
}
