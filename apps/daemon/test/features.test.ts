import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon, type Daemon } from '../src/server.js';
import { SecretVault } from '../src/vault.js';

type Scripted = { text?: string; tool?: { id: string; name: string; args: unknown } };

class Upstream {
  private server = createServer((req, res) => void this.handle(req, res));
  private turns: Scripted[] = [];
  private cursor = 0;
  port = 0;
  readonly requests: Array<Record<string, unknown>> = [];

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  script(turns: Scripted[]): void {
    this.turns = turns;
    this.cursor = 0;
    this.requests.length = 0;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw !== '') {
      try {
        this.requests.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Ignore an unparseable body; the response path is what the test asserts.
      }
    }
    const turn = this.turns[this.cursor];
    this.cursor += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (turn?.text !== undefined) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: turn.text }, finish_reason: 'stop' }] })}\n\n`);
    } else if (turn?.tool !== undefined) {
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: turn.tool.id,
                    type: 'function',
                    function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  }
}

let workspace: string;
let upstream: Upstream;
let daemon: Daemon;
let baseUrl: string;

const validTopic = JSON.stringify({
  cards: [
    {
      title: 'AI 与初级岗位',
      angle: '用招聘数据讲结构变化',
      scores: { demand: 80, competition: 40, differentiation: 70, speakability: 75 },
      composite: 74,
      rationale: '需求上升',
      risks: [],
    },
  ],
});
const validScript = JSON.stringify({
  hook: '先说结论。',
  sections: [
    { heading: '一、变化', content: '这一段是正文。', broll: '代码对比画面' },
    { heading: '二、原因', content: '第二段正文。' },
  ],
  cta: '你怎么看？',
  estimatedMinutes: 9,
});
const validShotList = JSON.stringify({
  shots: [
    { index: 0, time: '00:00', shot: '近景', visual: '人物特写', broll: '桌面', onScreenText: '开场', durationSec: 6 },
    { index: 1, time: '00:06', shot: '中景', visual: '屏幕录屏', broll: '代码', onScreenText: '', durationSec: 8 },
    { index: 2, time: '00:14', shot: '远景', visual: '办公室', broll: '空镜', onScreenText: '结论', durationSec: 5 },
  ],
});
const validPack = JSON.stringify({
  titles: [
    { title: '标题一', score: 90, reason: '具体' },
    { title: '标题二', score: 85, reason: '有冲突' },
    { title: '标题三', score: 80, reason: '有收益' },
  ],
  description: '简介',
  tags: ['AI'],
  chapters: [{ time: '00:00', label: '开场' }],
  coverBrief: '人物特写',
  compliance: [],
});
const validReview = JSON.stringify({
  summary: '整体表现稳定。',
  findings: [{ title: '封面影响点击', evidence: '换封面后播放上升', action: '保持新封面风格' }],
  nextTopics: ['下一期做工具对比'],
  score: 82,
});

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'features-ws-'));
  upstream = new Upstream();
  await upstream.start();

  const gateway = new ModelGateway({
    profiles: [
      {
        id: 'm1',
        userId: 'local-user',
        name: 'up',
        provider: 'openai-compatible',
        baseUrl: upstream.baseUrl,
        model: 'fake',
        apiKeyRef: 'keychain:test',
        contextWindow: 128_000,
        priceInPerM: 1,
        priceOutPerM: 2,
        isLocal: true,
      },
    ],
    resolveKey: async () => 'sk-test',
    maxRetries: 0,
    sleep: async () => {},
  });

  const secrets: Record<string, string> = {};
  daemon = await createDaemon({
    dbPath: join(workspace, 'db.sqlite'),
    workspaceRoot: join(workspace, 'project'),
    deviceId: 'd1',
    modelGateway: gateway,
    scheduler: false,
    // Mirror main.ts: the vault is the only holder of real keys.
    resolveSecret: (ref) => {
      if (ref.startsWith('env:')) return process.env[ref.slice(4)] ?? null;
      return secrets[ref.slice(6)] ?? null;
    },
    secretStore: {
      set: (name, value) => {
        secrets[name] = value;
        return `vault:${name}`;
      },
      delete: (name) => {
        delete secrets[name];
      },
    },
  });
  await daemon.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(daemon.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await daemon.close();
  await upstream.stop();
  rmSync(workspace, { recursive: true, force: true });
});

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

async function createProject(title = '测试项目'): Promise<string> {
  const created = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ title, description: '简介文本', tags: ['AI', '实验'] }),
  });
  expect(created.status).toBe(201);
  return created.body.project.id as string;
}

describe('R1 project lifecycle', () => {
  it('creates a project with description and tags', async () => {
    const id = await createProject('生命周期');
    const detail = await api(`/v1/projects/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.project.description).toBe('简介文本');
    expect(detail.body.project.tags).toEqual(['AI', '实验']);
    expect(detail.body.stats.artifacts).toBe(0);
    expect(detail.body.checklist.length).toBeGreaterThan(0);
  });

  it('patches title, description and tags', async () => {
    const id = await createProject();
    const patched = await api(`/v1/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: '新标题', tags: ['改过'] }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.project.title).toBe('新标题');
    expect(patched.body.project.tags).toEqual(['改过']);
  });

  it('soft deletes and restores a project', async () => {
    const id = await createProject('待删除');
    expect((await api(`/v1/projects/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/v1/projects/${id}`)).status).toBe(404);
    expect((await api(`/v1/projects/${id}/restore`, { method: 'POST' })).status).toBe(200);
    expect((await api(`/v1/projects/${id}`)).status).toBe(200);
  });

  it('searches projects by title, description and tag', async () => {
    await createProject('唯一搜索词甲');
    const searched = await api('/v1/projects?q=唯一搜索词甲');
    expect(searched.body.projects).toHaveLength(1);
    const byTag = await api('/v1/projects?q=实验');
    expect(byTag.body.projects.length).toBeGreaterThan(0);
  });
});

describe('R2 script, shot list and review generation', () => {
  it('generates a script artifact with a stable path', async () => {
    const id = await createProject('脚本生成');
    upstream.script([{ text: validScript }]);
    const result = await api(`/v1/projects/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'script', context: 'AI 与就业' }),
    });
    expect(result.status).toBe(201);
    expect(result.body.artifact.path).toBe('script/script.v1.md');
    expect(result.body.artifact.kind).toBe('script');
    const disk = readFileSync(join(workspace, 'project', 'projects', id, 'script', 'script.v1.md'), 'utf8');
    expect(disk).toContain('这一段是正文');
    expect(disk).toContain('开场钩子');
  });

  it('generates a shot list as a markdown table', async () => {
    const id = await createProject('分镜生成');
    upstream.script([{ text: validShotList }]);
    const result = await api(`/v1/projects/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'shot-list', context: '按脚本拆镜头' }),
    });
    expect(result.status).toBe(201);
    expect(result.body.artifact.path).toBe('shotlist/shot-list.v1.md');
    expect(result.body.artifact.kind).toBe('shot-list');
  });

  it('generates a review report that cites the metrics context', async () => {
    const id = await createProject('复盘生成');
    upstream.script([{ text: validReview }]);
    const result = await api(`/v1/projects/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'review-report', context: '播放 1000，点赞 50' }),
    });
    expect(result.status).toBe(201);
    expect(result.body.artifact.kind).toBe('review-report');
  });

  it('rejects an out-of-contract script payload without writing a file', async () => {
    const id = await createProject('坏脚本');
    upstream.script([{ text: '{"hook":"x","sections":[]}' }]);
    const result = await api(`/v1/projects/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'script', context: 'x' }),
    });
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('MODEL_BAD_OUTPUT');
    const artifacts = await api(`/v1/projects/${id}/artifacts`);
    expect(artifacts.body.artifacts).toHaveLength(0);
  });
});

describe('R3 approval resumes the run', () => {
  it('runs the pending tool after approval and completes the run', async () => {
    const id = await createProject('审批恢复');
    const run = await api(`/v1/projects/${id}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message: '删掉 ref.md', agentId: 'editor' }),
    });
    const runId = run.body.run.id as string;

    // ref.md is created relative to the shared workspace, the same root fs.delete uses.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(workspace, 'project', 'ref.md'), '待删除');

    upstream.script([{ tool: { id: 'c1', name: 'fs.delete', args: { path: 'ref.md' } } }]);
    const executed = await api(`/v1/runs/${runId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ message: '删掉 ref.md', agentId: 'editor' }),
    });
    expect(executed.body.outcome.status).toBe('waiting_approval');

    const pending = await api('/v1/approvals?status=pending');
    const approval = pending.body.approvals.find((item: { runId: string }) => item.runId === runId);
    expect(approval).toBeDefined();

    const approved = await api(`/v1/approvals/${approval.id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(approved.body.resumeHint.path).toBe(`/v1/runs/${runId}/resume`);

    upstream.script([{ text: '已删除。' }]);
    const resumed = await api(`/v1/runs/${runId}/resume`, {
      method: 'POST',
      body: JSON.stringify({ approvalId: approval.id }),
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body.outcome.status).toBe('succeeded');
    expect(resumed.body.run.status).toBe('succeeded');
    expect(readFileExists(join(workspace, 'project', 'ref.md'))).toBe(false);

    const messages = await api(`/v1/runs/${runId}`);
    expect(messages.body.messages.some((message: { role: string }) => message.role === 'tool')).toBe(true);
  });

  it('refuses to resume without an approved decision', async () => {
    const id = await createProject('未批准');
    const run = await api(`/v1/projects/${id}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message: '删文件', agentId: 'editor' }),
    });
    const runId = run.body.run.id as string;
    upstream.script([{ tool: { id: 'c2', name: 'fs.delete', args: { path: 'nope.md' } } }]);
    await api(`/v1/runs/${runId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ message: '删文件', agentId: 'editor' }),
    });
    const pending = await api('/v1/approvals?status=pending');
    const approval = pending.body.approvals.find((item: { runId: string }) => item.runId === runId);
    const rejected = await api(`/v1/approvals/${approval.id}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'rejected' }),
    });
    expect(rejected.status).toBe(200);
    const resumed = await api(`/v1/runs/${runId}/resume`, {
      method: 'POST',
      body: JSON.stringify({ approvalId: approval.id }),
    });
    expect(resumed.status).toBe(409);
    expect(resumed.body.error.code).toBe('APPROVAL_NOT_GRANTED');
  });
});

describe('R4 run cancellation', () => {
  it('cancels a queued run and rejects further execution', async () => {
    const id = await createProject('取消');
    const run = await api(`/v1/projects/${id}/runs`, {
      method: 'POST',
      body: JSON.stringify({ message: '待跑', agentId: 'scriptwriter' }),
    });
    const runId = run.body.run.id as string;
    const cancelled = await api(`/v1/runs/${runId}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.run.status).toBe('cancelled');

    const executed = await api(`/v1/runs/${runId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ message: '待跑' }),
    });
    expect(executed.body.outcome.status).toBe('failed');
    expect(executed.body.outcome.code).toBe('RUN_TERMINAL');

    expect((await api(`/v1/runs/${runId}/cancel`, { method: 'POST' })).status).toBe(409);
  });
});

describe('R5 automations', () => {
  it('creates a rule, runs it now, and records the artifact', async () => {
    const id = await createProject('自动化');
    const created = await api('/v1/automations', {
      method: 'POST',
      body: JSON.stringify({
        projectId: id,
        name: '每日选题',
        kind: 'topic-card',
        prompt: 'AI 与就业',
        intervalMinutes: 60,
      }),
    });
    expect(created.status).toBe(201);
    const automationId = created.body.automation.id as string;
    expect(created.body.automation.nextRunAt).not.toBeNull();

    upstream.script([{ text: validTopic }]);
    const run = await api(`/v1/automations/${automationId}/run`, { method: 'POST' });
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('succeeded');
    expect(typeof run.body.artifactId).toBe('string');

    const list = await api('/v1/automations');
    const automation = list.body.automations.find((entry: { id: string }) => entry.id === automationId);
    expect(automation.recentRuns[0].status).toBe('succeeded');
    expect(automation.lastRunAt).not.toBeNull();

    const toggled = await api(`/v1/automations/${automationId}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggled.body.automation.enabled).toBe(false);
    expect(toggled.body.automation.nextRunAt).toBeNull();

    expect((await api(`/v1/automations/${automationId}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('rejects an unknown project and an out-of-range interval', async () => {
    const missing = await api('/v1/automations', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'nope', name: 'x', kind: 'topic-card', prompt: 'y' }),
    });
    expect(missing.status).toBe(404);

    const id = await createProject('间隔');
    const short = await api('/v1/automations', {
      method: 'POST',
      body: JSON.stringify({ projectId: id, name: 'x', kind: 'topic-card', prompt: 'y', intervalMinutes: 1 }),
    });
    expect(short.status).toBe(400);
  });
});

describe('R6 metrics and library', () => {
  it('records metrics and aggregates them in the dashboard', async () => {
    const id = await createProject('数据');
    const first = await api(`/v1/projects/${id}/metrics`, {
      method: 'POST',
      body: JSON.stringify({ views: 1000, likes: 60, comments: 10, shares: 5, retentionPercent: 42, revenueCny: 3.5 }),
    });
    expect(first.status).toBe(201);
    await api(`/v1/projects/${id}/metrics`, {
      method: 'POST',
      body: JSON.stringify({ views: 2000, likes: 120, comments: 20 }),
    });

    const list = await api(`/v1/projects/${id}/metrics`);
    expect(list.body.metrics).toHaveLength(2);

    const dashboard = await api('/v1/dashboard');
    const summary = dashboard.body.metricsSummary.find((entry: { projectId: string }) => entry.projectId === id);
    expect(summary.views).toBe(3000);
    expect(summary.likes).toBe(180);

    expect((await api(`/v1/metrics/${first.body.metrics.id}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('lists artifacts across projects with their project titles', async () => {
    const id = await createProject('资料库项目');
    upstream.script([{ text: validTopic }]);
    await api(`/v1/projects/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'topic-card', context: 'x' }),
    });
    const library = await api('/v1/library?kind=topic-card');
    expect(library.body.items.some((item: { projectId: string }) => item.projectId === id)).toBe(true);
    const item = library.body.items.find((entry: { projectId: string }) => entry.projectId === id);
    expect(item.projectTitle).toBe('资料库项目');
  });

  it('rejects metrics with missing required counters', async () => {
    const id = await createProject('无效数据');
    const bad = await api(`/v1/projects/${id}/metrics`, {
      method: 'POST',
      body: JSON.stringify({ views: 1 }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('R7 secret vault', () => {
  it('stores, resolves and deletes a secret without writing it to the database', () => {
    const path = join(workspace, 'vault.json');
    const vault = new SecretVault(path);
    const ref = vault.set('m1', 'sk-super-secret');
    expect(ref).toBe('vault:m1');
    expect(vault.get(ref)).toBe('sk-super-secret');
    expect(vault.has(ref)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('sk-super-secret');

    vault.delete('m1');
    expect(vault.get(ref)).toBeNull();
    expect(vault.names()).toEqual([]);
  });

  it('resolves env refs and ignores unknown refs', () => {
    const vault = new SecretVault(join(workspace, 'vault2.json'));
    process.env['CREATOR_TEST_KEY'] = 'env-value';
    expect(vault.get('env:CREATOR_TEST_KEY')).toBe('env-value');
    expect(vault.get('keychain:missing')).toBeNull();
    delete process.env['CREATOR_TEST_KEY'];
  });
});

function readFileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

describe('R8 model profile switching', () => {
  it('saving a key adopts a runtime profile and reports it in the model list', async () => {
    const models = await api('/v1/settings/models');
    expect(models.status).toBe(200);
    expect(models.body.source).toBe('runtime');
    const runtimeId = models.body.models[0].id as string;
    expect(runtimeId).toBe('m1');

    const saved = await api(`/v1/settings/models/${runtimeId}/key`, {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'sk-adopted-key' }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.keyConfigured).toBe(true);

    const after = await api('/v1/settings/models');
    expect(after.body.source).toBe('stored');
    const adopted = after.body.models.find((model: { id: string }) => model.id === runtimeId);
    expect(adopted.apiKeyRef).toBe('vault:m1');
    expect(adopted.keyConfigured).toBe(true);
  });

  it('rejects a key for a model that exists nowhere', async () => {
    const missing = await api('/v1/settings/models/does-not-exist/key', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'x' }),
    });
    expect(missing.status).toBe(404);
  });
});

describe('R9 memory index', () => {
  it('indexes a saved artifact and finds it by Chinese substring', async () => {
    const id = await createProject('记忆索引');
    const saved = await api(`/v1/projects/${id}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'script',
        path: 'script/script.v1.md',
        content: '开场：地方财政的土地出让金，直接决定了你所在城市的公共服务水平。',
      }),
    });
    expect(saved.status).toBe(201);

    const found = await api(`/v1/memory/search?q=${encodeURIComponent('土地出让金')}&projectId=${id}`);
    expect(found.status).toBe(200);
    expect(found.body.hits.length).toBeGreaterThan(0);
    expect(found.body.hits[0].content).toContain('土地出让金');
    expect(found.body.indexed).toBeGreaterThan(0);
  });

  it('indexes generated artifacts automatically', async () => {
    const id = await createProject('自动索引');
    upstream.script([{ text: validTopic }]);
    const generated = await api(`/v1/projects/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'topic-card', context: 'AI 与就业' }),
    });
    expect(generated.status).toBe(201);

    const found = await api(`/v1/memory/search?q=${encodeURIComponent('初级岗位')}&projectId=${id}`);
    expect(found.body.hits.length).toBeGreaterThan(0);
  });

  it('scopes search to the requested project', async () => {
    const a = await createProject('项目甲');
    const b = await createProject('项目乙');
    await api(`/v1/projects/${a}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'script', path: 'script/a.md', content: '甲项目独有的关键词：蓝鲸计划' }),
    });
    await api(`/v1/projects/${b}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'script', path: 'script/b.md', content: '乙项目的内容，讲的是海洋生物学的基础概念' }),
    });

    const found = await api(`/v1/memory/search?q=${encodeURIComponent('蓝鲸计划')}&projectId=${a}`);
    expect(found.body.hits.every((hit: { projectId: string }) => hit.projectId === a)).toBe(true);

    const other = await api(`/v1/memory/search?q=${encodeURIComponent('蓝鲸计划')}&projectId=${b}`);
    expect(other.body.hits.every((hit: { content: string }) => !hit.content.includes('蓝鲸计划'))).toBe(true);
  });

  it('reindexes existing artifacts on demand', async () => {
    const id = await createProject('重建索引');
    await api(`/v1/projects/${id}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'research-notes', path: 'research/r.md', content: '待重建的资料来源' }),
    });
    await api(`/v1/memory/artifact:missing`, { method: 'DELETE' }).catch(() => null);

    const reindexed = await api('/v1/memory/reindex', {
      method: 'POST',
      body: JSON.stringify({ projectId: id }),
    });
    expect(reindexed.status).toBe(200);
    expect(reindexed.body.sources).toBeGreaterThan(0);
    expect(reindexed.body.totalChunks).toBeGreaterThan(0);
  });

  it('feeds retrieved memory into the generation prompt', async () => {
    const id = await createProject('记忆注入');
    await api(`/v1/projects/${id}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'research-notes',
        path: 'research/memory.md',
        content: '独家事实：某平台 2025 年校招岗位数量同比下降 18%。',
      }),
    });

    upstream.script([{ text: validTopic }]);
    const generated = await api(`/v1/projects/${id}/generate`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'topic-card', context: '校招岗位数量变化' }),
    });
    expect(generated.status).toBe(201);

    const prompt = JSON.stringify(upstream.requests.at(-1));
    expect(prompt).toContain('18%');
    expect(prompt).toContain('过往产物');
  });

  it('rejects an empty query', async () => {
    const empty = await api('/v1/memory/search?q=');
    expect(empty.status).toBe(400);
  });

  it('removes a source from the index', async () => {
    const id = await createProject('删除索引');
    const saved = await api(`/v1/projects/${id}/artifacts`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'script', path: 'script/x.md', content: '要被删除的索引内容' }),
    });
    const ref = encodeURIComponent(`artifact:${saved.body.artifact.id}`);
    const removed = await api(`/v1/memory/${ref}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBeGreaterThan(0);
    const again = await api(`/v1/memory/${ref}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });
});

describe('R10 embedding settings', () => {
  it('reports lexical-local mode when no embedding model is configured', async () => {
    const status = await api('/v1/settings/embedding');
    expect(status.status).toBe(200);
    expect(status.body.mode).toBe('lexical-local');
    expect(status.body.neural).toBe(false);
    expect(status.body.modelId).toBeNull();
  });

  it('rejects an unknown embedding model id', async () => {
    const bad = await api('/v1/settings/embedding', {
      method: 'POST',
      body: JSON.stringify({ modelId: 'nope' }),
    });
    expect(bad.status).toBe(404);
  });

  it('accepts the configured model id and reindexes', async () => {
    const saved = await api('/v1/settings/embedding', {
      method: 'POST',
      body: JSON.stringify({ modelId: 'm1' }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.modelId).toBe('m1');
    expect(saved.body.reindexed).toBeGreaterThanOrEqual(0);

    const status = await api('/v1/settings/embedding');
    expect(status.body.modelId).toBe('m1');

    const cleared = await api('/v1/settings/embedding', {
      method: 'POST',
      body: JSON.stringify({ modelId: null }),
    });
    expect(cleared.body.modelId).toBeNull();
  });
});
