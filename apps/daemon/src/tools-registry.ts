/**
 * The built-in tool set.
 *
 * Extracted from `server.ts` (which had grown past 2,800 lines and was doing the
 * HTTP surface, the scheduler and the tool catalogue all at once). Tools are the
 * one part with a stable shape — declare, validate, execute — so they separate
 * cleanly, and each one now carries MCP-style annotations that a client can read.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ToolError, fetchPage, listDirectory, type ListEntry, type ToolDefinition, type ToolHost } from '@creator-studio/tools';

export function registerFileTools(host: Pick<ToolHost, 'register'>, workspaceRoot: string): void {
  const read: ToolDefinition<{ path: string }, { content: string; bytes: number }> = {
    name: 'fs.read',
    risk: 'low',
    approvalKind: null,
    annotations: {
      title: '读取文件',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    pathArg: 'path',
    inputSchema: (input) => {
      if (typeof input !== 'object' || input === null) throw new ToolError('INVALID_INPUT', 'input must be object');
      const path = (input as Record<string, unknown>).path;
      if (typeof path !== 'string') throw new ToolError('INVALID_INPUT', 'path required');
      return { path };
    },
    execute: async (input) => {
      const { readFileSync } = await import('node:fs');
      const content = readFileSync(join(workspaceRoot, input.path), 'utf8');
      return { content, bytes: Buffer.byteLength(content) };
    },
  };

  const write: ToolDefinition<{ path: string; text: string }, { bytes: number; path: string }> = {
    name: 'fs.write',
    risk: 'medium',
    approvalKind: null,
    annotations: {
      title: '写入文件',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    pathArg: 'path',
    inputSchema: (input) => {
      const record = input as Record<string, unknown>;
      if (typeof record.path !== 'string' || typeof record.text !== 'string') {
        throw new ToolError('INVALID_INPUT', 'path and text required');
      }
      return { path: record.path, text: record.text };
    },
    execute: async (input) => {
      const { writeFileSync } = await import('node:fs');
      const target = join(workspaceRoot, input.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, input.text, 'utf8');
      return { bytes: Buffer.byteLength(input.text), path: input.path };
    },
  };

  const del: ToolDefinition<{ path: string }, { deleted: string }> = {
    name: 'fs.delete',
    risk: 'high',
    approvalKind: 'delete',
    annotations: {
      title: '删除文件',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    pathArg: 'path',
    inputSchema: (input) => {
      const path = (input as Record<string, unknown>).path;
      if (typeof path !== 'string') throw new ToolError('INVALID_INPUT', 'path required');
      return { path };
    },
    execute: async (input) => {
      rmSync(join(workspaceRoot, input.path), { force: true });
      return { deleted: input.path };
    },
  };

  host.register(read);
  host.register(write);
  host.register(del);
  registerResearchTools(host, workspaceRoot);
}

/**
 * Tools for the research stage. `fs.list` is a read-only map of one workspace
 * directory; `http.fetch` goes through the guarded fetcher so an agent cannot use
 * it to reach loopback services or internal networks.
 */
export function registerResearchTools(host: Pick<ToolHost, 'register'>, workspaceRoot: string): void {
  // No `pathArg` here on purpose: ToolHost's path sandbox requires a path, which
  // would make "list the workspace root" impossible. `listDirectory` applies
  // `resolveInsideWorkspace` itself, which is the other accepted sandbox shape.
  const list: ToolDefinition<
    { path?: string; limit?: number },
    { path: string; entries: ListEntry[]; truncated: boolean }
  > = {
    name: 'fs.list',
    risk: 'low',
    approvalKind: null,
    annotations: {
      title: '列出目录',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: (input) => {
      const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
      const path = record.path === undefined ? '' : record.path;
      if (typeof path !== 'string') throw new ToolError('INVALID_INPUT', 'path must be a string');
      const limit = typeof record.limit === 'number' ? Math.min(Math.max(Math.trunc(record.limit), 1), 500) : 200;
      return { path, limit };
    },
    execute: async (input) => listDirectory(input.path ?? '', { workspaceRoot, limit: input.limit ?? 200 }),
  };

  const fetchTool: ToolDefinition<{ url: string }, { url: string; title: string; text: string; truncated: boolean }> = {
    name: 'http.fetch',
    risk: 'medium',
    approvalKind: null,
    annotations: {
      title: '抓取网页',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: (input) => {
      const url = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).url : undefined;
      if (typeof url !== 'string' || url.trim() === '') throw new ToolError('INVALID_INPUT', 'url required');
      return { url };
    },
    execute: async (input) => {
      const page = await fetchPage(input.url);
      return { url: page.finalUrl, title: page.title, text: page.text, truncated: page.truncated };
    },
  };

  host.register(list as never);
  host.register(fetchTool as never);
}
