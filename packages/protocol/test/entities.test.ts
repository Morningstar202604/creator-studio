import { describe, expect, it } from 'vitest';
import {
  ApprovalSchema,
  ArtifactSchema,
  DeviceSchema,
  ModelProfileSchema,
  ProjectSchema,
  RunSchema,
  StepSchema,
  ToolGrantSchema,
} from '../src/index.js';

const iso = '2026-10-21T10:00:00.000Z';

describe('ProjectSchema', () => {
  it('accepts a fully specified project', () => {
    const value = {
      id: '0192f0c2-0000-7000-8000-000000000001',
      ownerId: 'user-1',
      title: '为什么 AI 编程正在杀死初级开发者',
      platform: 'bilibili',
      stage: 'script',
      workspacePath: 'C:/Users/x/CreatorStudio/proj-1',
      styleProfileId: null,
      createdAt: iso,
      updatedAt: iso,
      deletedAt: null,
    };
    expect(ProjectSchema.parse(value)).toEqual(value);
  });

  it('rejects an unknown stage', () => {
    const bad = {
      id: 'p1',
      ownerId: 'u1',
      title: 't',
      platform: 'bilibili',
      stage: 'editing',
      workspacePath: null,
      styleProfileId: null,
      createdAt: iso,
      updatedAt: iso,
      deletedAt: null,
    };
    expect(() => ProjectSchema.parse(bad)).toThrow();
  });

  it('rejects a non ISO timestamp', () => {
    const bad = {
      id: 'p1',
      ownerId: 'u1',
      title: 't',
      platform: 'bilibili',
      stage: 'topic',
      workspacePath: null,
      styleProfileId: null,
      createdAt: '2026-10-21 10:00',
      updatedAt: iso,
      deletedAt: null,
    };
    expect(() => ProjectSchema.parse(bad)).toThrow();
  });
});

describe('RunSchema', () => {
  it('accepts a queued run with zeroed budget', () => {
    const value = {
      id: 'r1',
      projectId: 'p1',
      parentRunId: null,
      agentId: 'scriptwriter',
      executionMode: 'local',
      status: 'queued',
      modelProfileId: 'm1',
      budget: { maxTokens: 200_000, maxCostCny: 5, usedTokens: 0, usedCostCny: 0 },
      inputRef: null,
      outputRef: null,
      error: null,
      startedAt: null,
      endedAt: null,
      createdAt: iso,
    };
    expect(RunSchema.parse(value)).toEqual(value);
  });

  it('rejects negative budget usage', () => {
    const bad = {
      id: 'r1',
      projectId: 'p1',
      parentRunId: null,
      agentId: 'scriptwriter',
      executionMode: 'local',
      status: 'running',
      modelProfileId: 'm1',
      budget: { maxTokens: 100, maxCostCny: 1, usedTokens: 0, usedCostCny: -0.01 },
      inputRef: null,
      outputRef: null,
      error: null,
      startedAt: iso,
      endedAt: null,
      createdAt: iso,
    };
    expect(() => RunSchema.parse(bad)).toThrow();
  });
});

describe('StepSchema', () => {
  const base = {
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
  };

  it('accepts a pending model step', () => {
    expect(StepSchema.parse(base)).toEqual(base);
  });

  it('rejects a tool step without a tool name', () => {
    expect(() => StepSchema.parse({ ...base, kind: 'tool' })).toThrow();
  });
});

describe('ArtifactSchema', () => {
  it('accepts a local artifact', () => {
    const value = {
      id: 'a1',
      projectId: 'p1',
      runId: 'r1',
      kind: 'script',
      path: 'script/script.v3.md',
      sha256: 'a'.repeat(64),
      mime: 'text/markdown',
      size: 4280,
      visibility: 'local',
      createdAt: iso,
    };
    expect(ArtifactSchema.parse(value)).toEqual(value);
  });

  it('rejects a short sha256', () => {
    const bad = {
      id: 'a1',
      projectId: 'p1',
      runId: 'r1',
      kind: 'script',
      path: 'x.md',
      sha256: 'abc',
      mime: 'text/markdown',
      size: 1,
      visibility: 'local',
      createdAt: iso,
    };
    expect(() => ArtifactSchema.parse(bad)).toThrow();
  });
});

describe('ApprovalSchema', () => {
  it('accepts a pending delete approval', () => {
    const value = {
      id: 'ap1',
      runId: 'r1',
      stepId: 's1',
      kind: 'delete',
      payload: { path: 'raw/old-take.mp4', bytes: 1_288_490_188 },
      decision: 'pending',
      requestedAt: iso,
      decidedAt: null,
      decidedBy: null,
    };
    expect(ApprovalSchema.parse(value)).toEqual(value);
  });
});

describe('DeviceSchema', () => {
  it('accepts a paired windows device', () => {
    const value = {
      id: 'd1',
      userId: 'u1',
      name: '台机',
      os: 'windows',
      publicKey: 'pk',
      capabilities: ['fs.read', 'fs.write', 'media.probe'],
      lastSeenAt: iso,
      revokedAt: null,
    };
    expect(DeviceSchema.parse(value)).toEqual(value);
  });
});

describe('ToolGrantSchema', () => {
  it('accepts a scoped ask grant', () => {
    const value = { id: 'g1', deviceId: 'd1', tool: 'fs.write', scope: 'workspace/**', mode: 'ask' };
    expect(ToolGrantSchema.parse(value)).toEqual(value);
  });

  it('rejects an unknown mode', () => {
    expect(() =>
      ToolGrantSchema.parse({ id: 'g1', deviceId: 'd1', tool: 'fs.write', scope: '*', mode: 'allow' }),
    ).toThrow();
  });
});

describe('ModelProfileSchema', () => {
  it('marks local providers', () => {
    const value = {
      id: 'm1',
      userId: 'u1',
      name: 'Ollama qwen3',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3:14b',
      apiKeyRef: 'keychain:ollama-local',
      contextWindow: 32_768,
      priceInPerM: 0,
      priceOutPerM: 0,
      isLocal: true,
    };
    expect(ModelProfileSchema.parse(value)).toEqual(value);
  });

  it('rejects an api key stored inline in baseUrl', () => {
    expect(() =>
      ModelProfileSchema.parse({
        id: 'm2',
        userId: 'u1',
        name: 'bad',
        provider: 'openai-compatible',
        baseUrl: 'https://sk-live-abc123@example.com/v1',
        model: 'x',
        apiKeyRef: 'keychain:x',
        contextWindow: 8_000,
        priceInPerM: 1,
        priceOutPerM: 2,
        isLocal: false,
      }),
    ).toThrow();
  });
});
