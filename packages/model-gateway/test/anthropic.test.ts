import { describe, expect, it } from 'vitest';
import { ModelError, createAnthropicAdapter } from '../src/index.js';
import { collect, profile, streamResponse, textResponse } from './helpers.js';

const anthropicProfile = profile({
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-test',
});

describe('anthropic adapter', () => {
  it('streams text deltas and usage', async () => {
    const adapter = createAnthropicAdapter();
    const fetchImpl = async () =>
      streamResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":0}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);

    const deltas = await collect(
      adapter.chat(
        { profile: anthropicProfile, apiKey: 'k', fetchImpl },
        { messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] },
      ),
    );

    expect(deltas).toContainEqual({ kind: 'text', text: '你好' });
    expect(deltas).toContainEqual({ kind: 'done', finishReason: 'stop' });
    expect(deltas).toContainEqual({ kind: 'usage', usage: { inputTokens: 9, outputTokens: 0 } });
    expect(deltas).toContainEqual({ kind: 'usage', usage: { inputTokens: 0, outputTokens: 4 } });
  });

  it('sends the system prompt in a top-level field', async () => {
    const adapter = createAnthropicAdapter();
    let captured: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return streamResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']);
    }) as unknown as typeof fetch;

    await collect(
      adapter.chat(
        { profile: anthropicProfile, apiKey: 'k', fetchImpl },
        { messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }] },
      ),
    );

    expect(captured.system).toBe('SYS');
    const messages = captured.messages as Array<{ role: string; content: string }>;
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('streams tool_use input json deltas', async () => {
    const adapter = createAnthropicAdapter();
    const fetchImpl = async () =>
      streamResponse([
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"fs.read"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.md\\"}"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);

    const deltas = await collect(
      adapter.chat({ profile: anthropicProfile, apiKey: 'k', fetchImpl }, { messages: [] }),
    );

    expect(deltas).toContainEqual({
      kind: 'tool_call',
      id: 'toolu_1',
      name: 'fs.read',
      argumentsJson: '',
    });
    expect(deltas).toContainEqual({
      kind: 'tool_call',
      id: 'toolu_1',
      name: 'fs.read',
      argumentsJson: '{"path":"a.md"}',
    });
  });

  it('maps 401 to MODEL_AUTH', async () => {
    const adapter = createAnthropicAdapter();
    const fetchImpl = async () => textResponse('{"error":{"type":"authentication_error"}}', 401);
    await expect(
      collect(adapter.chat({ profile: anthropicProfile, apiKey: 'k', fetchImpl }, { messages: [] })),
    ).rejects.toMatchObject({ code: 'MODEL_AUTH' });
  });

  it('throws on an in-stream error event', async () => {
    const adapter = createAnthropicAdapter();
    const fetchImpl = async () =>
      streamResponse([
        'event: error\ndata: {"type":"error","error":{"message":"overloaded"}}\n\n',
      ]);
    try {
      await collect(adapter.chat({ profile: anthropicProfile, apiKey: 'k', fetchImpl }, { messages: [] }));
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).code).toBe('MODEL_BAD_RESPONSE');
    }
  });
});
