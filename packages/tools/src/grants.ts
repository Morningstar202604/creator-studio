import type { GrantMode, ToolGrant } from '@creator-studio/protocol';

export type GrantDecision = {
  decision: 'auto' | 'ask' | 'deny';
  reason: 'MATCHED' | 'NO_GRANT' | 'DENIED_BY_RULE';
  grant: ToolGrant | null;
};

/**
 * Minimal glob: `**` matches any number of path segments, `*` matches within
 * one segment, everything else is literal. `?`, `[]` and `{}` are intentionally
 * unsupported so scope semantics stay predictable.
 */
export function matchScope(pattern: string, target: string): boolean {
  const patternParts = pattern.split('/').filter((part) => part !== '');
  const targetParts = target.split('/').filter((part) => part !== '');
  return matchParts(patternParts, 0, targetParts, 0);
}

function matchParts(pattern: string[], pi: number, target: string[], ti: number): boolean {
  if (pi === pattern.length) return ti === target.length;

  const head = pattern[pi] as string;

  if (head === '**') {
    for (let skip = ti; skip <= target.length; skip += 1) {
      if (matchParts(pattern, pi + 1, target, skip)) return true;
    }
    return false;
  }

  if (ti >= target.length) return false;
  const segment = target[ti] as string;
  if (!matchSegment(head, segment)) return false;
  return matchParts(pattern, pi + 1, target, ti + 1);
}

function matchSegment(pattern: string, segment: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === segment;
  const parts = pattern.split('*');
  let cursor = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as string;
    if (part === '') {
      if (index === parts.length - 1) return true;
      continue;
    }
    const found = segment.indexOf(part, cursor);
    if (found === -1) return false;
    if (index === 0 && found !== 0) return false;
    cursor = found + part.length;
  }
  const last = parts[parts.length - 1] as string;
  return last === '' || segment.endsWith(last);
}

export type EvaluateOptions = {
  grants: ToolGrant[];
  deviceId: string;
  tool: string;
  target: string;
};

/**
 * Deny wins over ask wins over auto. No matching grant means deny.
 */
export function evaluateGrant({ grants, deviceId, tool, target }: EvaluateOptions): GrantDecision {
  const candidates = grants.filter(
    (grant) => grant.deviceId === deviceId && (grant.tool === tool || grant.tool === '*') && matchScope(grant.scope, target),
  );

  if (candidates.length === 0) {
    return { decision: 'deny', reason: 'NO_GRANT', grant: null };
  }

  const byMode = (mode: GrantMode) => candidates.filter((grant) => grant.mode === mode);

  const denied = byMode('deny');
  if (denied.length > 0) {
    return { decision: 'deny', reason: 'DENIED_BY_RULE', grant: mostSpecific(denied) };
  }

  const ask = byMode('ask');
  if (ask.length > 0) {
    return { decision: 'ask', reason: 'MATCHED', grant: mostSpecific(ask) };
  }

  return { decision: 'auto', reason: 'MATCHED', grant: mostSpecific(byMode('auto')) };
}

function mostSpecific(grants: ToolGrant[]): ToolGrant | null {
  if (grants.length === 0) return null;
  return [...grants].sort((a, b) => specificity(b.scope) - specificity(a.scope))[0] ?? null;
}

function specificity(scope: string): number {
  const wildcards = (scope.match(/\*/g) ?? []).length;
  return scope.length - wildcards * 10;
}
