#!/usr/bin/env node
import { ModelError, ModelGateway } from '../packages/model-gateway/dist/index.js';

const PROFILE = {
  id: 'smoke-offline',
  userId: 'smoke',
  name: 'offline-fake',
  provider: 'openai-compatible',
  baseUrl: 'http://offline.invalid/v1',
  model: 'creator-studio-fake-v1',
  apiKeyRef: 'env:SMOKE_FAKE_KEY',
  contextWindow: 32_000,
  priceInPerM: 1,
  priceOutPerM: 2,
  isLocal: true,
};

const REAL_CANDIDATES = [
  {
    env: 'OPENAI_API_KEY',
    profile: {
      ...PROFILE,
      id: 'smoke-openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: process.env.SMOKE_OPENAI_MODEL ?? 'gpt-4o-mini',
      apiKeyRef: 'env:OPENAI_API_KEY',
      contextWindow: 128_000,
      isLocal: false,
    },
  },
  {
    env: 'DEEPSEEK_API_KEY',
    profile: {
      ...PROFILE,
      id: 'smoke-deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: process.env.SMOKE_DEEPSEEK_MODEL ?? 'deepseek-chat',
      apiKeyRef: 'env:DEEPSEEK_API_KEY',
      contextWindow: 64_000,
      isLocal: false,
    },
  },
  {
    env: 'ANTHROPIC_API_KEY',
    profile: {
      ...PROFILE,
      id: 'smoke-anthropic',
      name: 'Anthropic',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: process.env.SMOKE_ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest',
      apiKeyRef: 'env:ANTHROPIC_API_KEY',
      contextWindow: 200_000,
      isLocal: false,
    },
  },
  {
    env: 'OLLAMA_BASE_URL',
    profile: {
      ...PROFILE,
      id: 'smoke-ollama',
      name: 'Ollama',
      baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1',
      model: process.env.SMOKE_OLLAMA_MODEL ?? 'qwen2.5:7b',
      apiKeyRef: 'env:OLLAMA_DUMMY',
      priceInPerM: 0,
      priceOutPerM: 0,
    },
  },
];

function parseArgs(argv) {
  const modeIndex = argv.indexOf('--mode');
  const mode = modeIndex === -1 ? 'offline' : argv[modeIndex + 1];
  return { help: argv.includes('--help') || argv.includes('-h'), mode: mode ?? '' };
}

function printHelp() {
  console.log('Usage: node scripts/smoke-model.mjs [--mode offline|real]');
  console.log('Default mode is deterministic offline and needs no credentials or network.');
  console.log('Real mode uses the first configured provider and is an external dependency.');
}

function assertThat(condition, message) {
  if (!condition) throw new Error(message);
}

async function collect(iterable) {
  const deltas = [];
  for await (const delta of iterable) deltas.push(delta);
  return deltas;
}

function streamResponse(text, status = 200) {
  const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`;
  const done = 'data: [DONE]\n\n';
  return new Response(payload + done, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function textResponse(body, status) {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function makeGateway(overrides = {}) {
  return new ModelGateway({
    profiles: [PROFILE],
    resolveKey: async () => 'offline-key',
    maxRetries: 0,
    sleep: async () => {},
    ...overrides,
  });
}

async function expectModelError(operation, code) {
  try {
    await operation();
  } catch (error) {
    assertThat(error instanceof ModelError, `expected ModelError, received ${String(error)}`);
    assertThat(error.code === code, `expected ${code}, received ${error.code}`);
    return error;
  }
  throw new Error(`expected ${code} to be thrown`);
}

async function runOffline() {
  let successCalls = 0;
  const successGateway = makeGateway({
    fetchImpl: async () => {
      successCalls += 1;
      return streamResponse(JSON.stringify({ result: 'offline-ok', structured: true }));
    },
  });
  const successDeltas = await collect(
    successGateway.chat({}, { messages: [{ role: 'user', content: 'deterministic ping' }], maxOutputTokens: 32 }),
  );
  const text = successDeltas
    .filter((delta) => delta.kind === 'text')
    .map((delta) => delta.text)
    .join('');
  const structured = JSON.parse(text);
  assertThat(successCalls === 1, `expected one fake provider call, received ${successCalls}`);
  assertThat(structured.result === 'offline-ok' && structured.structured === true, 'structured fake output mismatch');
  console.log('PASS offline success + structured output');

  const networkGateway = makeGateway({ fetchImpl: async () => { throw new Error('offline network failure'); } });
  const networkError = await expectModelError(
    () => collect(networkGateway.chat({}, { messages: [{ role: 'user', content: 'network error' }] })),
    'MODEL_NETWORK',
  );
  assertThat(networkError.retryable === true, 'network errors must remain retryable');
  console.log('PASS offline network error mapping');

  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  let signalSeen = false;
  const abortGateway = makeGateway({
    fetchImpl: async (_url, init) => {
      const signal = init?.signal;
      signalSeen = signal !== undefined;
      resolveStarted();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const pending = collect(
    abortGateway.chat({}, { messages: [{ role: 'user', content: 'cancel me' }], signal: controller.signal }),
  );
  await started;
  controller.abort();
  const abortError = await expectModelError(() => pending, 'MODEL_TIMEOUT');
  assertThat(signalSeen, 'fake provider did not receive AbortSignal');
  assertThat(abortError.retryable === false, 'aborted requests must not retry');
  console.log('PASS offline cancellation propagation');

  const secret = `sk-${'offline-secret'.repeat(3)}`;
  const redactionGateway = makeGateway({ fetchImpl: async () => textResponse(`invalid key ${secret}`, 401) });
  const redactionError = await expectModelError(
    () => collect(redactionGateway.chat({}, { messages: [{ role: 'user', content: 'redact' }] })),
    'MODEL_AUTH',
  );
  assertThat(!redactionError.message.includes(secret), 'secret leaked in model error message');
  assertThat(!(redactionError.providerMessage ?? '').includes(secret), 'secret leaked in provider message');
  console.log('PASS offline error redaction');

  let budgetCalls = 0;
  const budgetGateway = makeGateway({ fetchImpl: async () => { budgetCalls += 1; return streamResponse('unexpected'); } });
  await expectModelError(
    () => collect(budgetGateway.chat(
      { budget: { maxTokens: 4, maxCostCny: 0.001, usedTokens: 0, usedCostCny: 0 } },
      { messages: [{ role: 'user', content: 'x'.repeat(100) }], maxOutputTokens: 32 },
    )),
    'BUDGET_EXCEEDED',
  );
  assertThat(budgetCalls === 0, 'budget rejection must happen before provider call');
  console.log('PASS offline budget boundary');
  console.log('PASS offline model smoke: 5 scenarios');
}

async function runReal() {
  const available = REAL_CANDIDATES.filter((candidate) =>
    candidate.env === 'OLLAMA_BASE_URL' ? process.env.OLLAMA_BASE_URL !== undefined : Boolean(process.env[candidate.env]),
  );
  if (available.length === 0) {
    console.error('NOT_ENABLED: real provider smoke requires OPENAI_API_KEY, DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, or OLLAMA_BASE_URL.');
    return 2;
  }

  let failures = 0;
  for (const candidate of available) {
    const gateway = new ModelGateway({
      profiles: [candidate.profile],
      resolveKey: async () => process.env[candidate.env] ?? 'ollama',
      maxRetries: 0,
    });
    const started = Date.now();
    try {
      const deltas = await collect(gateway.chat({}, {
        messages: [
          { role: 'system', content: 'Reply with exactly: OK' },
          { role: 'user', content: 'ping' },
        ],
        maxOutputTokens: 16,
        temperature: 0,
      }));
      const text = deltas.filter((delta) => delta.kind === 'text').map((delta) => delta.text).join('');
      assertThat(text.length > 0, 'real provider returned no text');
      console.log(`PASS real ${candidate.profile.name} (${candidate.profile.model}) ${Date.now() - started}ms`);
    } catch (error) {
      failures += 1;
      const code = error instanceof ModelError ? error.code : 'UNKNOWN';
      console.log(`FAIL real ${candidate.profile.name} (${candidate.profile.model}) ${code}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
if (args.mode !== 'offline' && args.mode !== 'real') {
  console.error(`invalid mode: ${args.mode || '(missing)'}`);
  printHelp();
  process.exit(2);
}

if (args.mode === 'offline') {
  try {
    await runOffline();
    process.exit(0);
  } catch (error) {
    console.error(`FAIL offline model smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

process.exit(await runReal());
