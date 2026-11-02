import { createCloud } from './server.js';
import { MemoryStore, type CloudStore } from './store.js';
import { PostgresStore } from './store-postgres.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) out[token.slice(2)] = 'true';
    else {
      out[token.slice(2)] = next;
      index += 1;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const port = Number.parseInt(args.port ?? '8787', 10);
  const host = args.host ?? '127.0.0.1';
  // DATABASE_URL switches to Postgres; without it the cloud plane keeps its
  // zero-dependency in-memory behaviour, which is what the desktop app expects.
  const databaseUrl = args.database ?? process.env.DATABASE_URL ?? '';
  let store: CloudStore = new MemoryStore();
  let storage = '内存（未配置 Postgres）';
  if (databaseUrl !== '') {
    const postgres = new PostgresStore(databaseUrl);
    await postgres.init();
    store = postgres;
    storage = 'Postgres';
  }

  const cloud = createCloud({ store });
  const actual = await cloud.listen(port, host);

  console.log('稿台云端控制面已启动');
  console.log(`  API      http://${host}:${actual}`);
  console.log(`  隧道     ws://${host}:${actual}/v1/tunnel?deviceId=...&token=...`);
  console.log(`  存储     ${storage}`);

  const shutdown = async (): Promise<void> => {
    await cloud.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error('cloud 启动失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
