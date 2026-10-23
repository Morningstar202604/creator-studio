import type { ToolGrant } from '@creator-studio/protocol';
import { describe, expect, it } from 'vitest';
import { evaluateGrant } from '../src/index.js';

const grant = (overrides: Partial<ToolGrant>): ToolGrant => ({
  id: 'g1',
  deviceId: 'd1',
  tool: 'fs.write',
  scope: '**',
  mode: 'auto',
  ...overrides,
});

describe('R1 deny by default', () => {
  it('denies when no grant exists', () => {
    const decision = evaluateGrant({ grants: [], deviceId: 'd1', tool: 'fs.write', target: 'a.md' });
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toBe('NO_GRANT');
  });

  it('denies a grant belonging to another device', () => {
    const decision = evaluateGrant({
      grants: [grant({ deviceId: 'd2' })],
      deviceId: 'd1',
      tool: 'fs.write',
      target: 'a.md',
    });
    expect(decision.decision).toBe('deny');
  });

  it('denies a grant for another tool', () => {
    const decision = evaluateGrant({
      grants: [grant({ tool: 'fs.read' })],
      deviceId: 'd1',
      tool: 'fs.write',
      target: 'a.md',
    });
    expect(decision.decision).toBe('deny');
  });

  it('denies when the scope does not match', () => {
    const decision = evaluateGrant({
      grants: [grant({ scope: 'script/**' })],
      deviceId: 'd1',
      tool: 'fs.write',
      target: 'raw/a.md',
    });
    expect(decision.decision).toBe('deny');
  });
});

describe('R2 deny beats auto', () => {
  it('denies a path covered by a narrower deny rule', () => {
    const decision = evaluateGrant({
      grants: [grant({ id: 'g1', scope: '**', mode: 'auto' }), grant({ id: 'g2', scope: 'secret/**', mode: 'deny' })],
      deviceId: 'd1',
      tool: 'fs.write',
      target: 'secret/a.md',
    });
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toBe('DENIED_BY_RULE');
    expect(decision.grant?.id).toBe('g2');
  });

  it('allows outside the deny scope', () => {
    const decision = evaluateGrant({
      grants: [grant({ id: 'g1', scope: '**', mode: 'auto' }), grant({ id: 'g2', scope: 'secret/**', mode: 'deny' })],
      deviceId: 'd1',
      tool: 'fs.write',
      target: 'script/a.md',
    });
    expect(decision.decision).toBe('auto');
  });

  it('ask beats auto', () => {
    const decision = evaluateGrant({
      grants: [grant({ id: 'g1', scope: '**', mode: 'auto' }), grant({ id: 'g2', scope: 'script/**', mode: 'ask' })],
      deviceId: 'd1',
      tool: 'fs.write',
      target: 'script/a.md',
    });
    expect(decision.decision).toBe('ask');
  });
});

describe('wildcard tool grants', () => {
  it('a * tool grant covers any tool', () => {
    const decision = evaluateGrant({
      grants: [grant({ tool: '*', scope: '**', mode: 'auto' })],
      deviceId: 'd1',
      tool: 'media.probe',
      target: 'a.mp4',
    });
    expect(decision.decision).toBe('auto');
  });
});

describe('specificity ordering', () => {
  it('reports the most specific deny grant', () => {
    const decision = evaluateGrant({
      grants: [
        grant({ id: 'broad', scope: '**', mode: 'deny' }),
        grant({ id: 'narrow', scope: 'script/**', mode: 'deny' }),
      ],
      deviceId: 'd1',
      tool: 'fs.write',
      target: 'script/a.md',
    });
    expect(decision.grant?.id).toBe('narrow');
  });
});
