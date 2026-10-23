#!/usr/bin/env node
/**
 * Real-provider smoke test. Skips cleanly when no credential is present.
 *
 *   OPENAI_API_KEY=sk-... node scripts/smoke-model.mjs
 *   DEEPSEEK_API_KEY=sk-... node scripts/smoke-model.mjs
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/smoke-model.mjs
 *   OLLAMA_BASE_URL=http://127.0.0.1:11434/v1 node scripts/smoke-model.mjs
 */

import { ModelGateway, ModelError } from '../packages/model-gateway/dist/index.js';

const CANDIDATES = [
  {
    env: 'OPENAI_API_KEY',
    profile: {
      id: 'smoke-openai',
      userId: 'smoke',
      name: 'OpenAI',
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: process.env.SMOKE_OPENAI_MODEL ?? 'gpt-4o-mini',
      apiKeyRef: 'env:OPENAI_API_KEY',
      contextWindow: 128_000,
      priceInPerM: 1,
      priceOutPerM: 2,
      isLocal: false,
    },
  },
  {
    env: 'DEEPSEEK_API_KEY',
    profile: {
      id: 'smoke-deepseek',
      userId: 'smoke',
      name: 'DeepSeek',
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      model: process.env.SMOKE_DEEPSEEK_MODEL ?? 'deepseek-chat',
      apiKeyRef: 'env:DEEPSEEK_API_KEY',
      contextWindow: 64_000,
      priceInPerM: 1,
      priceOutPerM: 2,
      isLocal: false,
    },
  },
  {
    env: 'ANTHROPIC_API_KEY',
    profile: {
      id: 'smoke-anthropic',
      userId: 'smoke',
      name: 'Anthropic',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: process.env.SMOKE_ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest',
      apiKeyRef: 'env:ANTHROPIC_API_KEY',
      contextWindow: 200_000,
      priceInPerM: 1,
      priceOutPerM: 5,
      isLocal: false,
    },
  },
  {
    env: 'OLLAMA_BASE_URL',
    profile: {
      id: 'smoke-ollama',
      userId: 'smoke',
      name: 'Ollama',
      provider: 'openai-compatible',
      baseUrl: `${process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1'}`,
      model: process.env.SMOKE_OLLAMA_MODEL ?? 'qwen2.5:7b',
      apiKeyRef: 'env:OLLAMA_DUMMY',
      contextWindow: 32_000,
      priceInPerM: 0,
      priceOutPerM: 0,
      isLocal: true,
    },
  },
];

const available = CANDIDATES.filter((candidate) =>
  candidate.env === 'OLLAMA_BASE_URL' ? process.env.OLLAMA_BASE_URL !== undefined : Boolean(process.env[candidate.env]),
);

if (available.length === 0) {
  console.log('SKIP: no provider credentials in this environment.');
  console.log('      Set OPENAI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / OLLAMA_BASE_URL to run.');
  process.exit(0);
}

let failures = 0;

for (const candidate of available) {
  const gateway = new ModelGateway({
    profiles: [candidate.profile],
    resolveKey: async () => process.env[candidate.env] ?? 'ollama',
  });

  const started = Date.now();
  let text = '';
  try {
    for await (const delta of gateway.chat({}, {
      messages: [
        { role: 'system', content: 'Reply with exactly: OK' },
        { role: 'user', content: 'ping' },
      ],
      maxOutputTokens: 16,
      temperature: 0,
    })) {
      if (delta.kind === 'text') text += delta.text;
    }
    const elapsed = Date.now() - started;
    console.log(`PASS ${candidate.profile.name} (${candidate.profile.model}) ${elapsed}ms -> ${JSON.stringify(text.slice(0, 40))}`);
  } catch (error) {
    failures += 1;
    const code = error instanceof ModelError ? error.code : 'UNKNOWN';
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${candidate.profile.name} (${candidate.profile.model}) ${code}: ${message}`);
  }
}

process.exit(failures === 0 ? 0 : 1);
