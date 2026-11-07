/**
 * MCP (Model Context Protocol) endpoint — the standard way external agents
 * (Claude Desktop, Claude Code, Cursor, VS Code, …) drive this daemon.
 *
 * Why a second protocol surface: the daemon already speaks HTTP/JSON for its
 * own UI and CLI. MCP is the wire format the rest of the ecosystem standardised
 * on; exposing the same operations there means any MCP client can create
 * projects, generate artifacts and export packs without a bespoke integration.
 *
 * Design, deliberately consolidated (the pattern Nomi and other 2026 local
 * workbenches converged on): a handful of high-level tools, not one per route.
 * Every tool call re-enters the daemon's own HTTP API over loopback, so MCP
 * inherits exactly the validation, approval gating, audit trail and revision
 * checks the first-party clients get — there is no second, weaker code path.
 *
 * Transport: Streamable HTTP, stateless (a fresh server + transport per
 * request, no session ids), per the 2026-07-28 spec. The daemon binds
 * 127.0.0.1 only, which is the network boundary; nothing here is reachable
 * from other hosts.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

type Json = Record<string, unknown>;

/** One consolidated tool surface: reads, generation, and the publish gate. */
function buildServer(baseUrl: string, instructions: string): McpServer {
  const server = new McpServer(
    { name: 'creator-studio', version: '0.19.1', title: 'Creator Studio' },
    { instructions },
  );

  const call = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Json> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (response.status >= 400) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        detail = parsed.error?.message ?? text;
      } catch {
        /* keep raw text */
      }
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    return text === '' ? {} : (JSON.parse(text) as Json);
  };

  const text = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'List projects, optionally including soft-deleted ones.',
      inputSchema: { includeDeleted: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ includeDeleted }) => text(await call('GET', `/v1/projects${includeDeleted ? '?includeDeleted=1' : ''}`)),
  );

  server.registerTool(
    'get_project',
    {
      title: 'Get project',
      description: 'Full project detail: stage, checklist, artifacts, runs, workspace path.',
      inputSchema: { projectId: z.string().describe('Project id from list_projects') },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId }) => text(await call('GET', `/v1/projects/${projectId}`)),
  );

  server.registerTool(
    'list_scenarios',
    {
      title: 'List scenarios',
      description: 'Scenario pipelines (video, novel, podcast, course, writing, shorts) with their stages.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(await call('GET', '/v1/scenarios')),
  );

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description: 'Create a project under a scenario pipeline. Returns the new project id.',
      inputSchema: {
        title: z.string().min(1).describe('Human-readable project title'),
        scenarioId: z.string().describe('Scenario id from list_scenarios, e.g. video or novel'),
        platform: z.string().optional().describe('Publishing platform, e.g. bilibili'),
        description: z.string().optional(),
      },
    },
    async ({ title, scenarioId, platform, description }) =>
      text(await call('POST', '/v1/projects', { title, scenarioId, platform, description })),
  );

  server.registerTool(
    'list_artifacts',
    {
      title: 'List artifacts',
      description: 'Every artifact a project has produced, newest first, with ids and versions.',
      inputSchema: { projectId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ projectId }) => text(await call('GET', `/v1/projects/${projectId}/artifacts`)),
  );

  server.registerTool(
    'read_artifact',
    {
      title: 'Read artifact',
      description: 'The full content of one artifact (topic card, script, shot list, …).',
      inputSchema: { artifactId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ artifactId }) => text(await call('GET', `/v1/artifacts/${artifactId}`)),
  );

  server.registerTool(
    'generate_artifact',
    {
      title: 'Generate artifact',
      description:
        'Run one pipeline stage through the configured model: topic-card, research-notes, script, shot-list, publish-pack, outline, chapter, subtitles, review — depending on the scenario.',
      inputSchema: {
        projectId: z.string(),
        kind: z.string().describe('Artifact kind, as the scenario defines it'),
        context: z.string().describe('What this stage should be about'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ projectId, kind, context }) =>
      text(await call('POST', `/v1/projects/${projectId}/generate`, { kind, context })),
  );

  server.registerTool(
    'run_agent',
    {
      title: 'Run agent',
      description:
        'Have one of the studio agents (producer, scout, researcher, scriptwriter, director, editor, packager, critic) work on a project. Tool calls inside the run stay approval-gated.',
      inputSchema: {
        projectId: z.string(),
        agentId: z.string().describe('Agent id, e.g. scriptwriter'),
        message: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ projectId, agentId, message }) =>
      text(await call('POST', `/v1/projects/${projectId}/runs`, { agentId, message })),
  );

  server.registerTool(
    'publish_pack',
    {
      title: 'Publish pack',
      description:
        'Export the publish-ready zip (newest version of each artifact unless history is requested). Fails with the missing checklist items if the pipeline is not ready.',
      inputSchema: {
        projectId: z.string(),
        history: z.boolean().optional().describe('Include every version, not just the newest per kind'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ projectId, history }) => text(await call('POST', `/v1/projects/${projectId}/publish`, { history })),
  );

  server.registerTool(
    'search_memory',
    {
      title: 'Search memory',
      description: 'Lexical (and, if enabled, neural) search over everything the studio has memorised.',
      inputSchema: {
        query: z.string().min(1),
        projectId: z.string().optional(),
        limit: z.number().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, projectId, limit }) => {
      const search = new URLSearchParams({ q: query });
      if (projectId !== undefined) search.set('projectId', projectId);
      if (limit !== undefined) search.set('limit', String(limit));
      return text(await call('GET', `/v1/memory/search?${search.toString()}`));
    },
  );

  return server;
}

const MCP_INSTRUCTIONS = [
  'Creator Studio is a local-first production desk for solo creators.',
  'Start with list_scenarios to see the pipelines, then create_project and walk the',
  'stages with generate_artifact. publish_pack only succeeds once the checklist is',
  'complete. Everything runs on this machine; generation needs a configured model.',
].join(' ');

/** Mounts POST/GET/DELETE /mcp on an already-built Fastify app. */
export function registerMcpEndpoint(app: FastifyInstance): void {
  const baseUrl = (): string => {
    const address = app.server.address() as AddressInfo | null;
    return address === null ? 'http://127.0.0.1' : `http://127.0.0.1:${address.port}`;
  };

  app.post('/mcp', async (request, reply) => {
    // Stateless per the 2026-07-28 spec: a fresh server + transport answers each
    // request and nothing survives it. reply.hijack() hands the raw response to
    // the SDK, which owns content-type and framing from here on.
    reply.hijack();
    const server = buildServer(baseUrl(), MCP_INSTRUCTIONS);
    // Omitting sessionIdGenerator leaves it undefined at runtime, which the
    // transport treats as stateless — exactly what the spec wants; passing it
    // explicitly trips exactOptionalPropertyTypes.
    const transport = new StreamableHTTPServerTransport();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless servers offer no server-initiated SSE stream and no session to
  // terminate; say so instead of letting the 404 handler confuse clients.
  app.get('/mcp', async (_request, reply) => {
    reply.code(405).header('allow', 'POST').send({ error: { code: 'METHOD_NOT_ALLOWED', message: 'stateless MCP: use POST' } });
  });
  app.delete('/mcp', async (_request, reply) => {
    reply.code(405).header('allow', 'POST').send({ error: { code: 'METHOD_NOT_ALLOWED', message: 'stateless MCP: no session to delete' } });
  });
}
