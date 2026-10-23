import { describe, expect, it } from 'vitest';
import { ModelError, createOpenAiAdapter, redact, truncate } from '../src/index.js';
import { collect, profile, streamResponse, textResponse } from './helpers.js';

describe('openai adapter', () => {
  it('streams text deltas and usage', async () => {
    const adapter = createOpenAiAdapter();
    const fetchImpl = async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]);

    const deltas = await collect(
      adapter.chat({ profile: profile(), apiKey: 'sk-test', fetchImpl }, { messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(deltas).toContainEqual({ kind: 'text', text: '你' });
    expect(deltas).toContainEqual({ kind: 'text', text: '好' });
    expect(deltas).toContainEqual({ kind: 'done', finishReason: 'stop' });
    expect(deltas).toContainEqual({ kind: 'usage', usage: { inputTokens: 12, outputTokens: 2 } });
  });

  it('handles a chunk boundary inside a json payload', async () => {
    const adapter = createOpenAiAdapter();
    const fetchImpl = async () =>
      streamResponse(['data: {"choices":[{"delta":{"con', 'tent":"跨块"}}]}\n\n', 'data: [DONE]\n\n']);

    const deltas = await collect(
      adapter.chat({ profile: profile(), apiKey: 'k', fetchImpl }, { messages: [] }),
    );
    expect(deltas).toContainEqual({ kind: 'text', text: '跨块' });
  });

  it('maps 401 to MODEL_AUTH without leaking the key', async () => {
    const adapter = createOpenAiAdapter();
    const key = 'sk-test-SECRETVALUE1234567890';
    const fetchImpl = async () => textResponse(`{"error":"invalid key ${key}"}`, 401);

    try {
      await collect(adapter.chat({ profile: profile(), apiKey: key, fetchImpl }, { messages: [] }));
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelError);
      const modelError = error as ModelError;
      expect(modelError.code).toBe('MODEL_AUTH');
      expect(modelError.message).not.toContain(key);
      expect(modelError.providerMessage ?? '').not.toContain(key);
    }
  });

  it('maps 429 to retryable MODEL_RATE_LIMITED', async () => {
    const adapter = createOpenAiAdapter();
    const fetchImpl = async () => textResponse('slow down', 429);
    await expect(
      collect(adapter.chat({ profile: profile(), apiKey: 'k', fetchImpl }, { messages: [] })),
    ).rejects.toMatchObject({ code: 'MODEL_RATE_LIMITED', retryable: true });
  });

  it('maps 503 to retryable MODEL_UNAVAILABLE', async () => {
    const adapter = createOpenAiAdapter();
    const fetchImpl = async () => textResponse('down', 503);
    await expect(
      collect(adapter.chat({ profile: profile(), apiKey: 'k', fetchImpl }, { messages: [] })),
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', retryable: true });
  });

  it('maps context overflow', async () => {
    const adapter = createOpenAiAdapter();
    const fetchImpl = async () => textResponse('maximum context length exceeded', 400);
    await expect(
      collect(adapter.chat({ profile: profile(), apiKey: 'k', fetchImpl }, { messages: [] })),
    ).rejects.toMatchObject({ code: 'MODEL_CONTEXT_OVERFLOW' });
  });

  it('throws MODEL_BAD_RESPONSE on a non-json chunk', async () => {
    const adapter = createOpenAiAdapter();
    const fetchImpl = async () => streamResponse(['data: not-json\n\n']);
    await expect(
      collect(adapter.chat({ profile: profile(), apiKey: 'k', fetchImpl }, { messages: [] })),
    ).rejects.toMatchObject({ code: 'MODEL_BAD_RESPONSE' });
  });
});

describe('redact', () => {
  it('masks sk- keys', () => {
    expect(redact('key is sk-abcdefgh12345678 here')).toBe('key is [REDACTED] here');
  });

  it('masks bearer tokens', () => {
    expect(redact('Authorization: Bearer abcdefgh12345678')).toContain('[REDACTED]');
  });

  it('leaves short strings alone', () => {
    expect(redact('model gpt-4')).toBe('model gpt-4');
  });

  it('truncate caps length and redacts', () => {
    const out = truncate(`${'x'.repeat(600)} sk-abcdefgh12345678`, 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out).not.toContain('sk-abcdefgh12345678');
  });
});
