import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon } from './server.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true';
    } else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function defaultDataDir(): string {
  const os = platform();
  if (os === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'CreatorStudio');
  }
  if (os === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'CreatorStudio');
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'creator-studio');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir ?? defaultDataDir();
  const workspaceRoot = args.workspace ?? join(dataDir, 'workspace');
  const port = Number.parseInt(args.port ?? '7878', 10);
  const host = args.host ?? '127.0.0.1';

  if (args['api-key'] !== undefined) {
    console.warn(
      'WARN: --api-key 会把密钥写进进程参数，可能被系统进程列表读到。' +
        '推荐改用环境变量 MODEL_API_KEY 或系统钥匙串。',
    );
  }

  const apiKey = args['api-key'] ?? process.env.MODEL_API_KEY ?? '';
  const baseUrl = args.baseUrl ?? process.env.MODEL_BASE_URL ?? 'https://api.openai.com/v1';
  const model = args.model ?? process.env.MODEL_NAME ?? 'gpt-4o-mini';

  const gateway = new ModelGateway({
    profiles: [
      {
        id: 'default',
        userId: 'local-user',
        name: args.provider ?? 'openai-compatible',
        provider: 'openai-compatible',
        baseUrl,
        model,
        apiKeyRef: 'env:MODEL_API_KEY',
        contextWindow: 128_000,
        priceInPerM: Number.parseFloat(process.env.MODEL_PRICE_IN ?? '0'),
        priceOutPerM: Number.parseFloat(process.env.MODEL_PRICE_OUT ?? '0'),
        isLocal: baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost'),
      },
    ],
    resolveKey: async () => apiKey,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  const daemon = await createDaemon({
    dbPath: join(dataDir, 'creator-studio.db'),
    workspaceRoot,
    deviceId: 'local-device',
    modelGateway: gateway,
    logger: false,
  });

  await daemon.app.listen({ port, host });

  console.log(`稿台 daemon 已启动`);
  console.log(`  API      http://${host}:${port}`);
  console.log(`  数据目录 ${dataDir}`);
  console.log(`  工作区   ${workspaceRoot}`);
  console.log(`  模型     ${model} @ ${baseUrl}`);
  console.log(`  密钥     ${apiKey === '' ? '未配置（生成类接口会返回 MODEL_AUTH）' : '已配置'}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n收到 ${signal}，正在关闭…`);
    await daemon.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('daemon 启动失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
