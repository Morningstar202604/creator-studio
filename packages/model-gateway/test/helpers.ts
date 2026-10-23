import type { ModelProfile } from '@creator-studio/protocol';

export function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'm1',
    userId: 'u1',
    name: 'test',
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    apiKeyRef: 'keychain:test',
    contextWindow: 128_000,
    priceInPerM: 18,
    priceOutPerM: 72,
    isLocal: false,
    ...overrides,
  };
}

export function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

export async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of gen) out.push(item);
  return out;
}
