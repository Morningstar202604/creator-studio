import type { ModelProfile } from '@creator-studio/protocol';
import { SseParser, type SseEvent } from './sse.js';
import { ModelError, truncate } from './errors.js';
import type { Adapter, AdapterContext, ChatRequest, ModelDelta, Usage } from './types.js';

type OpenAiChoice = {
  delta?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
  finish_reason?: string | null;
};

type OpenAiToolCall = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type OpenAiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
};

type OpenAiChunk = {
  choices?: OpenAiChoice[];
  usage?: OpenAiUsage | null;
  error?: { message?: string; type?: string; code?: string };
};

function endpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function mapStatus(status: number, body: string): ModelError {
  const providerMessage = truncate(body, 300);
  if (status === 401 || status === 403) {
    return new ModelError('MODEL_AUTH', 'provider rejected the credentials', {
      status,
      providerMessage,
    });
  }
  if (status === 429) {
    return new ModelError('MODEL_RATE_LIMITED', 'provider rate limit hit', {
      status,
      retryable: true,
      providerMessage,
    });
  }
  if (status === 400 && /context|too long|maximum/i.test(body)) {
    return new ModelError('MODEL_CONTEXT_OVERFLOW', 'input exceeds the model context window', {
      status,
      providerMessage,
    });
  }
  if (status >= 500) {
    return new ModelError('MODEL_UNAVAILABLE', 'provider is unavailable', {
      status,
      retryable: true,
      providerMessage,
    });
  }
  return new ModelError('MODEL_BAD_RESPONSE', `unexpected status ${status}`, {
    status,
    providerMessage,
  });
}

function buildBody(profile: ModelProfile, req: ChatRequest, stream: boolean): Record<string, unknown> {
  return {
    model: profile.model,
    messages: req.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
      ...(message.toolCalls === undefined
        ? {}
        : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.argumentsJson },
            })),
          }),
    })),
    temperature: req.temperature ?? 0.7,
    max_tokens: req.maxOutputTokens ?? 4096,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

function* mapChunk(raw: OpenAiChunk, accumulator: Map<number, { id: string; name: string; args: string }>): Generator<ModelDelta> {
  if (raw.error?.message) {
    throw new ModelError('MODEL_BAD_RESPONSE', truncate(raw.error.message, 200), {
      providerMessage: truncate(raw.error.message, 300),
    });
  }

  for (const choice of raw.choices ?? []) {
    const text = choice.delta?.content;
    if (typeof text === 'string' && text.length > 0) {
      yield { kind: 'text', text };
    }
    for (const call of choice.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const existing = accumulator.get(index) ?? { id: '', name: '', args: '' };
      const next = {
        id: call.id ?? existing.id,
        name: call.function?.name ?? existing.name,
        args: existing.args + (call.function?.arguments ?? ''),
      };
      accumulator.set(index, next);
      const callId = next.id === '' ? `call_${index}` : next.id;
      if (call.function?.name) {
        yield { kind: 'tool_call', id: callId, name: next.name, argumentsJson: '' };
      }
      if (typeof call.function?.arguments === 'string' && call.function.arguments.length > 0) {
        yield { kind: 'tool_call', id: callId, name: next.name, argumentsJson: call.function.arguments };
      }
    }
    if (choice.finish_reason === 'stop') yield { kind: 'done', finishReason: 'stop' };
    else if (choice.finish_reason === 'length') yield { kind: 'done', finishReason: 'length' };
    else if (choice.finish_reason === 'tool_calls') yield { kind: 'done', finishReason: 'tool_calls' };
  }

  if (raw.usage) {
    const usage: Usage = {
      inputTokens: raw.usage.prompt_tokens ?? 0,
      outputTokens: raw.usage.completion_tokens ?? 0,
    };
    yield { kind: 'usage', usage };
  }
}

export function createOpenAiAdapter(): Adapter {
  return {
    provider: 'openai-compatible',
    async *chat(ctx: AdapterContext, req: ChatRequest): AsyncGenerator<ModelDelta, void, unknown> {
      const doFetch = ctx.fetchImpl ?? fetch;
      let response: Response;
      try {
        response = await doFetch(endpoint(ctx.profile.baseUrl), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${ctx.apiKey}`,
          },
          body: JSON.stringify(buildBody(ctx.profile, req, true)),
          ...(req.signal === undefined ? {} : { signal: req.signal }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'network failure';
        const aborted = req.signal?.aborted === true;
        throw new ModelError(aborted ? 'MODEL_TIMEOUT' : 'MODEL_NETWORK', truncate(message), {
          retryable: !aborted,
        });
      }

      if (!response.ok) {
        const body = await safeText(response);
        throw mapStatus(response.status, body);
      }
      if (response.body === null) {
        throw new ModelError('MODEL_BAD_RESPONSE', 'empty response body');
      }

      const parser = new SseParser();
      const decoder = new TextDecoder();
      const accumulator = new Map<number, { id: string; name: string; args: string }>();
      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const event of parser.push(chunk)) {
          const deltas = handleEvent(event, accumulator);
          for (const delta of deltas) yield delta;
        }
      }
      for (const event of parser.flush()) {
        for (const delta of handleEvent(event, accumulator)) yield delta;
      }
    },
  };
}

function* handleEvent(
  event: SseEvent,
  accumulator: Map<number, { id: string; name: string; args: string }>,
): Generator<ModelDelta> {
  const data = event.data.trim();
  if (data === '' || data === '[DONE]') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new ModelError('MODEL_BAD_RESPONSE', 'stream chunk is not valid json');
  }
  yield* mapChunk(parsed as OpenAiChunk, accumulator);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
