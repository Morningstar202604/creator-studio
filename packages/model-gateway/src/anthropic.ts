import { SseParser, type SseEvent } from './sse.js';
import { ModelError, truncate } from './errors.js';
import type { Adapter, AdapterContext, ChatRequest, ModelDelta } from './types.js';

type AnthropicEvent = {
  type?: string;
  delta?: { type?: string; text?: string; partial_json?: string };
  content_block?: { type?: string; id?: string; name?: string };
  index?: number;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
};

function endpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/messages') ? trimmed : `${trimmed}/messages`;
}

function mapStatus(status: number, body: string): ModelError {
  const providerMessage = truncate(body, 300);
  if (status === 401 || status === 403) {
    return new ModelError('MODEL_AUTH', 'provider rejected the credentials', { status, providerMessage });
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
  return new ModelError('MODEL_BAD_RESPONSE', `unexpected status ${status}`, { status, providerMessage });
}

export function createAnthropicAdapter(): Adapter {
  return {
    provider: 'anthropic',
    async *chat(ctx: AdapterContext, req: ChatRequest): AsyncGenerator<ModelDelta, void, unknown> {
      const doFetch = ctx.fetchImpl ?? fetch;
      const system = req.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
      const messages = req.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }));

      let response: Response;
      try {
        response = await doFetch(endpoint(ctx.profile.baseUrl), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': ctx.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: ctx.profile.model,
            ...(system === '' ? {} : { system }),
            messages,
            max_tokens: req.maxOutputTokens ?? 4096,
            temperature: req.temperature ?? 0.7,
            stream: true,
          }),
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
        const body = await response.text().catch(() => '');
        throw mapStatus(response.status, body);
      }
      if (response.body === null) {
        throw new ModelError('MODEL_BAD_RESPONSE', 'empty response body');
      }

      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      const toolBlocks = new Map<number, { id: string; name: string }>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          yield* handle(event, toolBlocks);
        }
      }
      for (const event of parser.flush()) {
        yield* handle(event, toolBlocks);
      }
    },
  };
}

function* handle(
  event: SseEvent,
  toolBlocks: Map<number, { id: string; name: string }>,
): Generator<ModelDelta> {
  const data = event.data.trim();
  if (data === '' || data === '[DONE]') return;
  let parsed: AnthropicEvent;
  try {
    parsed = JSON.parse(data) as AnthropicEvent;
  } catch {
    throw new ModelError('MODEL_BAD_RESPONSE', 'stream chunk is not valid json');
  }

  if (parsed.type === 'error' && parsed.error?.message) {
    throw new ModelError('MODEL_BAD_RESPONSE', truncate(parsed.error.message), {
      providerMessage: truncate(parsed.error.message, 300),
    });
  }

  if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
    const index = parsed.index ?? 0;
    toolBlocks.set(index, { id: parsed.content_block.id ?? `tool_${index}`, name: parsed.content_block.name ?? '' });
    yield { kind: 'tool_call', id: parsed.content_block.id ?? `tool_${index}`, name: parsed.content_block.name ?? '', argumentsJson: '' };
  }

  if (parsed.type === 'content_block_delta') {
    if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
      yield { kind: 'text', text: parsed.delta.text };
    }
    if (parsed.delta?.type === 'input_json_delta' && parsed.delta.partial_json) {
      const block = toolBlocks.get(parsed.index ?? 0);
      yield {
        kind: 'tool_call',
        id: block?.id ?? 'tool',
        name: block?.name ?? '',
        argumentsJson: parsed.delta.partial_json,
      };
    }
  }

  if (parsed.type === 'message_start' && parsed.message?.usage) {
    yield {
      kind: 'usage',
      usage: {
        inputTokens: parsed.message.usage.input_tokens ?? 0,
        outputTokens: parsed.message.usage.output_tokens ?? 0,
      },
    };
  }

  if (parsed.type === 'message_delta') {
    if (parsed.usage) {
      yield {
        kind: 'usage',
        usage: {
          inputTokens: parsed.usage.input_tokens ?? 0,
          outputTokens: parsed.usage.output_tokens ?? 0,
        },
      };
    }
  }

  if (parsed.type === 'message_stop') {
    yield { kind: 'done', finishReason: 'stop' };
  }
}
