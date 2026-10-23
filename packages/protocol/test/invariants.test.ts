import { describe, expect, it } from 'vitest';
import {
  DomainError,
  assertApproved,
  assertBudget,
  canStartStep,
  requiresApproval,
} from '../src/index.js';

const iso = '2026-10-21T10:00:00.000Z';

const budget = { maxTokens: 1000, maxCostCny: 5, usedTokens: 0, usedCostCny: 0 };

function step(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 's1',
    runId: 'r1',
    index: 0,
    kind: 'model' as const,
    status: 'pending' as const,
    toolName: null,
    toolArgs: null,
    resultRef: null,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

describe('R1 canStartStep', () => {
  it('allows the first step of a run', () => {
    expect(canStartStep([step()])).toEqual({ ok: true });
  });

  it('rejects a second running step in the same run', () => {
    const result = canStartStep([step({ id: 's1', status: 'running' }), step({ id: 's2', index: 1 })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('RUN_ALREADY_HAS_RUNNING_STEP');
  });

  it('allows a new step after the previous one finished', () => {
    const result = canStartStep([step({ id: 's1', status: 'succeeded' }), step({ id: 's2', index: 1 })]);
    expect(result).toEqual({ ok: true });
  });
});

describe('R2 approval gate', () => {
  it('flags destructive tools only', () => {
    expect(requiresApproval('delete')).toBe(true);
    expect(requiresApproval('publish')).toBe(true);
    expect(requiresApproval('purchase')).toBe(true);
    expect(requiresApproval('write-outside-workspace')).toBe(true);
    expect(requiresApproval('shell-exec')).toBe(true);
    expect(requiresApproval('fs.read')).toBe(false);
  });

  it('throws APPROVAL_REQUIRED when nothing is approved', () => {
    try {
      assertApproved('delete', null);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('APPROVAL_REQUIRED');
    }
  });

  it('throws when the approval is still pending', () => {
    const approval = {
      id: 'ap1',
      runId: 'r1',
      stepId: 's1',
      kind: 'delete' as const,
      payload: {},
      decision: 'pending' as const,
      requestedAt: iso,
      decidedAt: null,
      decidedBy: null,
    };
    expect(() => assertApproved('delete', approval)).toThrowError(/APPROVAL_REQUIRED/);
  });

  it('passes when approved and the kind matches', () => {
    const approval = {
      id: 'ap1',
      runId: 'r1',
      stepId: 's1',
      kind: 'delete' as const,
      payload: {},
      decision: 'approved' as const,
      requestedAt: iso,
      decidedAt: iso,
      decidedBy: 'u1',
    };
    expect(() => assertApproved('delete', approval)).not.toThrow();
  });

  it('does not let a publish approval authorise a delete', () => {
    const approval = {
      id: 'ap1',
      runId: 'r1',
      stepId: 's1',
      kind: 'publish' as const,
      payload: {},
      decision: 'approved' as const,
      requestedAt: iso,
      decidedAt: iso,
      decidedBy: 'u1',
    };
    expect(() => assertApproved('delete', approval)).toThrowError(/APPROVAL_REQUIRED/);
  });
});

describe('R3 budget gate', () => {
  it('allows an estimate under the cap', () => {
    expect(() => assertBudget(budget, { tokens: 100, costCny: 0.5 })).not.toThrow();
  });

  it('throws BUDGET_EXCEEDED when cost would cross the cap', () => {
    const near = { ...budget, usedCostCny: 4.9 };
    try {
      assertBudget(near, { tokens: 10, costCny: 0.2 });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('BUDGET_EXCEEDED');
    }
  });

  it('throws when tokens would cross the cap', () => {
    const near = { ...budget, usedTokens: 990 };
    expect(() => assertBudget(near, { tokens: 20, costCny: 0 })).toThrowError(/BUDGET_EXCEEDED/);
  });

  it('is fail-closed on non-finite estimates', () => {
    expect(() => assertBudget(budget, { tokens: Number.NaN, costCny: 0 })).toThrowError(/BUDGET_EXCEEDED/);
  });
});
