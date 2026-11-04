import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { ModelGateway } from '@creator-studio/model-gateway';
import { createDaemon } from './server.js';
import { SecretVault } from './vault.js';

/**
 * Reads the product version from this package's manifest.
 *
 * The daemon runs from `apps/daemon/dist`, so the manifest is two levels up. A
 * missing or malformed file is not fatal — reporting `0.0.0-dev` is better than
 * refusing to start over a cosmetic string.
 */
function readPackageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

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

/** The built React bundle, when running from a repo checkout (web mode). */
function findWebRoot(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'desktop', 'dist'),
    join(here, '..', '..', '..', 'apps', 'desktop', 'dist'),
    join(here, 'web'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html')));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir ?? defaultDataDir();
  const workspaceRoot = args.workspace ?? join(dataDir, 'workspace');
  const port = Number.parseInt(args.port ?? '7878', 10);
  const host = args.host ?? '127.0.0.1';
  const noWeb = args['no-web'] === 'true';

  if (args['api-key'] !== undefined) {
    console.warn(
      'WARN: --api-key 会把密钥写进进程参数，可能被系统进程列表读到。' +
        '推荐改用环境变量 MODEL_API_KEY 或界面里保存到本机密钥库。',
    );
  }

  const vault = new SecretVault(join(dataDir, 'secrets.json'));
  const envKey = args['api-key'] ?? process.env.MODEL_API_KEY ?? '';
  const apiKeyRef = envKey !== '' ? vault.set('default', envKey) : 'env:MODEL_API_KEY';

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
        apiKeyRef,
        contextWindow: 128_000,
        priceInPerM: Number.parseFloat(process.env.MODEL_PRICE_IN ?? '0'),
        priceOutPerM: Number.parseFloat(process.env.MODEL_PRICE_OUT ?? '0'),
        isLocal: baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost'),
      },
    ],
    resolveKey: async (ref) => vault.get(ref),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  const webRoot = noWeb ? undefined : findWebRoot();
  const daemon = await createDaemon({
    appVersion: readPackageVersion(),
    dbPath: join(dataDir, 'creator-studio.db'),
    workspaceRoot,
    deviceId: 'local-device',
    modelGateway: gateway,
    logger: false,
    resolveSecret: (ref) => vault.get(ref),
    secretStore: vault,
    // Opt in with --remote-embeddings when the provider serves /embeddings; the
    // default local hash embedder needs no network and never fails.
    remoteEmbeddings: args['remote-embeddings'] === 'true',
    // The UI is served by this daemon; that origin is the only browser origin
    // allowed to call the API. Split-frontend dev opts in via
    // CREATOR_STUDIO_DEV_ORIGIN instead of opening every localhost port.
    publicOrigin: `http://${host}:${port}`,
    ...(webRoot === undefined ? {} : { webRoot }),
  });

  await daemon.app.listen({ port, host });

  console.log('稿台 daemon 已启动');
  console.log(`  API      http://${host}:${port}`);
  if (webRoot !== undefined) console.log(`  界面     http://${host}:${port}/`);
  console.log(`  数据目录 ${dataDir}`);
  console.log(`  工作区   ${workspaceRoot}`);
  console.log(`  模型     ${model} @ ${baseUrl}`);
  console.log(`  密钥     ${vault.get(apiKeyRef) !== null ? '已配置' : '未配置（生成类接口会返回 MODEL_AUTH，可在界面设置）'}`);

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
