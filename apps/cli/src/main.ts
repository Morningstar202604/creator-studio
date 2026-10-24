#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

import { ApiError, DaemonClient } from './client.js';

const DEFAULT_URL = process.env['CREATOR_STUDIO_URL'] ?? 'http://127.0.0.1:7878';

const HELP = `稿台 CLI — 对本地 daemon 的脚本化入口

用法: cs <command> [options]

  cs health                          检查 daemon 与能力
  cs projects [--json]               列出项目
  cs new <title> [--platform bilibili] [--desc "..."] [--tag AI --tag 就业]
  cs show <projectId>                项目详情 + 检查表
  cs rm <projectId>                  软删除项目（可用 restore 恢复）
  cs restore <projectId>             恢复软删除项目
  cs artifacts <projectId>           列出产物
  cs cat <artifactId>                打印产物内容
  cs gen <projectId> <kind> <context>
                                     kind: topic-card|research-notes|script|shot-list|publish-pack|review-report
  cs run <projectId> <agent> <message>
                                     agent: producer|scout|researcher|scriptwriter|director|editor|packager|critic
  cs runs [--status failed]          最近运行
  cs checklist <projectId>           发布检查表
  cs publish <projectId>             导出发布包 zip
  cs usage                           用量与花费
  cs pipeline <projectId> <context>  一键跑选题→资料→脚本→分镜→包装

全局: --url <daemonUrl>  覆盖默认 ${DEFAULT_URL}
`;

function parse(argv: string[]): { command: string; args: string[]; flags: Record<string, string | string[]> } {
  const args: string[] = [];
  const flags: Record<string, string | string[]> = {};
  let url: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === '--url') {
      url = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = 'true';
      } else {
        const existing = flags[key];
        flags[key] = existing === undefined ? next : Array.isArray(existing) ? [...existing, next] : [existing, next];
        index += 1;
      }
      continue;
    }
    args.push(token);
  }
  const command = args.shift() ?? 'help';
  if (url !== undefined) flags['url'] = url;
  return { command, args, flags };
}

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function line(value: string): void {
  process.stdout.write(`${value}\n`);
}

async function main(): Promise<number> {
  const { command, args, flags } = parse(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  const client = new DaemonClient({ baseUrl: String(flags['url'] ?? DEFAULT_URL) });

  switch (command) {
    case 'health': {
      const health = await client.health();
      if (flags['json'] !== undefined) {
        json(health);
      } else {
        line(`daemon ok · api v${health.apiVersion} · ${health.workspaceRoot}`);
        line(`capabilities: ${health.capabilities.join(', ')}`);
      }
      return 0;
    }
    case 'projects': {
      const result = await client.listProjects(args[0] ?? '');
      if (flags['json'] !== undefined) {
        json(result);
        return 0;
      }
      line(`${result.counts.active} 个进行中 / 共 ${result.counts.total}`);
      for (const project of result.projects) {
        line(`${project.id.slice(0, 8)}  ${project.title}  [${project.stage}]  ${project.platform}`);
      }
      return 0;
    }
    case 'new': {
      const title = args.join(' ').trim();
      if (title === '') return usageError('缺少项目标题');
      const tags = Array.isArray(flags['tag']) ? flags['tag'] : flags['tag'] === undefined ? [] : [flags['tag']];
      const created = await client.createProject({
        title,
        ...(flags['platform'] === undefined ? {} : { platform: String(flags['platform']) }),
        ...(flags['desc'] === undefined ? {} : { description: String(flags['desc']) }),
        ...(tags.length === 0 ? {} : { tags }),
      });
      line(`${created.project.id}  ${created.project.title}`);
      return 0;
    }
    case 'show': {
      const detail = await client.getProject(requireArg(args, 0, 'projectId'));
      json(detail);
      return 0;
    }
    case 'rm': {
      const result = await client.deleteProject(requireArg(args, 0, 'projectId'));
      line(`已软删除 ${result.deleted}（可用 cs restore 恢复）`);
      return 0;
    }
    case 'restore': {
      const id = requireArg(args, 0, 'projectId');
      const result = await client.request<{ project: { id: string; title: string } }>(`/v1/projects/${id}/restore`, {
        method: 'POST',
      });
      line(`已恢复 ${result.project.id}  ${result.project.title}`);
      return 0;
    }
    case 'artifacts': {
      const result = await client.listArtifacts(requireArg(args, 0, 'projectId'));
      if (flags['json'] !== undefined) {
        json(result);
        return 0;
      }
      for (const artifact of result.artifacts) {
        line(`${artifact.id.slice(0, 8)}  ${artifact.kind.padEnd(14)}  ${artifact.path}`);
      }
      return 0;
    }
    case 'cat': {
      const result = await client.getArtifact(requireArg(args, 0, 'artifactId'));
      process.stdout.write(result.content.endsWith('\n') ? result.content : `${result.content}\n`);
      return 0;
    }
    case 'gen': {
      const projectId = requireArg(args, 0, 'projectId');
      const kind = requireArg(args, 1, 'kind');
      const context = args.slice(2).join(' ').trim();
      if (context === '') return usageError('缺少生成上下文');
      const result = await client.generate(projectId, kind, context);
      line(`已生成 ${result.artifact.kind} → ${result.artifact.path} (${result.artifact.id})`);
      return 0;
    }
    case 'run': {
      const projectId = requireArg(args, 0, 'projectId');
      const agentId = requireArg(args, 1, 'agent');
      const message = args.slice(2).join(' ').trim();
      if (message === '') return usageError('缺少消息');
      const created = await client.createRun(projectId, message, agentId);
      const executed = await client.executeRun(created.run.id, message, agentId);
      line(`run ${created.run.id} → ${executed.outcome.status}`);
      if (executed.outcome.text !== undefined && executed.outcome.text !== '') process.stdout.write(executed.outcome.text + '\n');
      return executed.outcome.status === 'failed' ? 1 : 0;
    }
    case 'runs': {
      const status = typeof flags['status'] === 'string' ? flags['status'] : undefined;
      const result = await client.listRuns(status === undefined ? {} : { status });
      for (const run of result.runs) {
        line(`${run.id.slice(0, 8)}  ${run.agentId.padEnd(12)}  ${run.status.padEnd(16)}  ${run.budget.usedTokens} tokens`);
      }
      return 0;
    }
    case 'checklist': {
      const result = await client.checklist(requireArg(args, 0, 'projectId'));
      for (const item of result.items) {
        line(`${item.ok ? '✓' : '·'} ${item.label}${item.required ? '' : '（可选）'}`);
      }
      line(result.ready ? 'READY' : `MISSING: ${result.missing.join(', ')}`);
      return result.ready ? 0 : 1;
    }
    case 'publish': {
      const result = await client.publish(requireArg(args, 0, 'projectId'));
      line(`${result.absolutePath ?? result.file}  ${result.bytes} bytes  ${result.entries.length} files`);
      return 0;
    }
    case 'usage': {
      json(await client.usage());
      return 0;
    }
    case 'pipeline': {
      const projectId = requireArg(args, 0, 'projectId');
      const context = args.slice(1).join(' ').trim();
      if (context === '') return usageError('缺少选题方向');
      const steps: Array<[string, string]> = [
        ['topic-card', context],
        ['research-notes', context],
        ['script', context],
        ['shot-list', context],
        ['publish-pack', context],
      ];
      for (const [kind, input] of steps) {
        try {
          const result = await client.generate(projectId, kind, input);
          line(`✓ ${kind} → ${result.artifact.path}`);
        } catch (error) {
          line(`✗ ${kind}: ${error instanceof Error ? error.message : String(error)}`);
          return 1;
        }
      }
      const checklist = await client.checklist(projectId);
      line(checklist.ready ? '检查表通过，可导出' : `检查表缺: ${checklist.missing.join(', ')}`);
      return checklist.ready ? 0 : 1;
    }
    case 'export-file': {
      // Debug helper: prints an exported file from a workspace path.
      const path = requireArg(args, 0, 'path');
      if (!existsSync(path)) return usageError(`文件不存在: ${path}`);
      process.stdout.write(readFileSync(path, 'utf8'));
      return 0;
    }
    case 'version': {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
      line(pkg.version);
      return 0;
    }
    default:
      process.stderr.write(`未知命令: ${command}\n\n${HELP}`);
      return 2;
  }
}

function requireArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (value === undefined || value === '') {
    throw new ApiError('INVALID_INPUT', `缺少参数 ${name}`, 0);
  }
  return value;
}

function usageError(message: string): number {
  process.stderr.write(`${message}\n`);
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ApiError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });

