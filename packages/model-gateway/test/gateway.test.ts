import { describe, expect, it, vi } from 'vitest';
import { ModelError, ModelGateway } from '../src/index.js';
import { collect, profile, streamResponse, textResponse } from './helpers.js';

const okStream = () =>
  streamResponse([
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

function makeGateway(overrides: Partial<ConstructorParameters<typeof ModelGateway>[0]> = {}) {
  return new ModelGateway({
    profiles: [profile()],
    resolveKey: async () => 'sk-test-key',
    sleep: async () => {},
    ...overrides,
  });
}

describe('R1 budget precheck', () => {
  it('rejects before calling fetch', async () => {
    const fetchImpl = vi.fn(async () => okStream());
    const gateway = makeGateway({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const budget = { maxTokens: 10, maxCostCny: 0.01, usedTokens: 0, usedCostCny: 0 };
    await expect(
      collect(
        gateway.chat(
          { budget },
          { messages: [{ role: 'user', content: 'x'.repeat(1000) }], maxOutputTokens: 4000 },
        ),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows a call well under the cap', async () => {
    const gateway = makeGateway({ fetchImpl: (async () => okStream()) as unknown as typeof fetch });
    const budget = { maxTokens: 1_000_000, maxCostCny: 100, usedTokens: 0, usedCostCny: 0 };
    const deltas = await collect(
      gateway.chat({ budget }, { messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16 }),
    );
    expect(deltas).toContainEqual({ kind: 'text', text: 'ok' });
  });
});

describe('R2 credential handling', () => {
  it('fails when the key is missing', async () => {
    const gateway = makeGateway({ resolveKey: async () => null });
    await expect(collect(gateway.chat({}, { messages: [] }))).rejects.toMatchObject({
      code: 'MODEL_AUTH',
    });
  });

  it('does not leak the key in error messages', async () => {
    const key = 'sk-test-SECRETVALUE1234567890';
    const gateway = makeGateway({
      resolveKey: async () => key,
      fetchImpl: (async () => textResponse(`bad key ${key}`, 401)) as unknown as typeof fetch,
    });
    try {
      await collect(gateway.chat({}, { messages: [] }));
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).message).not.toContain(key);
      expect((error as ModelError).providerMessage ?? '').not.toContain(key);
    }
  });
});

describe('R3 retry policy', () => {
  it('retries 429 up to maxRetries then fails', async () => {
    const fetchImpl = vi.fn(async () => textResponse('rate limited', 429));
    const gateway = makeGateway({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 2,
    });

    await expect(collect(gateway.chat({}, { messages: [] }))).rejects.toMatchObject({
      code: 'MODEL_RATE_LIMITED',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('succeeds after a transient 503', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? textResponse('down', 503) : okStream();
    });
    const gateway = makeGateway({ fetchImpl: fetchImpl as unknown as typeof fetch, maxRetries: 2 });

    const deltas = await collect(gateway.chat({}, { messages: [] }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(deltas).toContainEqual({ kind: 'text', text: 'ok' });
  });

  it('does not retry a non-retryable 401', async () => {
    const fetchImpl = vi.fn(async () => textResponse('nope', 401));
    const gateway = makeGateway({ fetchImpl: fetchImpl as unknown as typeof fetch, maxRetries: 3 });
    await expect(collect(gateway.chat({}, { messages: [] }))).rejects.toMatchObject({
      code: 'MODEL_AUTH',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry once a delta was already emitted', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const encoder = new TextEncoder();
        let reads = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            reads += 1;
            if (reads === 1) {
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
            } else {
              controller.error(new Error('socket reset'));
            }
          },
        });
        return new Response(stream, { status: 200 });
      }
      return okStream();
    });
    const gateway = makeGateway({ fetchImpl: fetchImpl as unknown as typeof fetch, maxRetries: 3 });

    const seen: unknown[] = [];
    try {
      for await (const delta of gateway.chat({}, { messages: [] })) seen.push(delta);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelError);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('backs off with doubling delays', async () => {
    const delays: number[] = [];
    const fetchImpl = vi.fn(async () => textResponse('boom', 503));
    const gateway = makeGateway({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await expect(collect(gateway.chat({}, { messages: [] }))).rejects.toMatchObject({
      code: 'MODEL_UNAVAILABLE',
    });
    expect(delays).toEqual([100, 200]);
  });
});

describe('profile routing', () => {
  it('routes by agent id', async () => {
    const profiles = [
      profile({ id: 'cheap', name: 'cheap', priceInPerM: 1, priceOutPerM: 1 }),
      profile({ id: 'strong', name: 'strong' }),
    ];
    const gateway = new ModelGateway({
      profiles,
      resolveKey: async () => 'k',
      routing: { critic: 'strong', scriptwriter: 'cheap' },
      fetchImpl: (async () => okStream()) as unknown as typeof fetch,
      sleep: async () => {},
    });

    expect(gateway.resolveProfile('critic', undefined).id).toBe('strong');
    expect(gateway.resolveProfile('scriptwriter', undefined).id).toBe('cheap');
    expect(gateway.resolveProfile(undefined, 'strong').id).toBe('strong');
    expect(gateway.resolveProfile('unknown-agent', undefined).id).toBe('cheap');
  });

  it('throws when the routed profile does not exist', () => {
    const gateway = makeGateway();
    expect(() => gateway.resolveProfile(undefined, 'missing')).toThrowError(/model profile not found/);
  });

  it('throws when no profiles are configured', () => {
    const gateway = new ModelGateway({ profiles: [], resolveKey: async () => 'k' });
    expect(() => gateway.resolveProfile(undefined, undefined)).toThrowError(/no model profiles/);
  });
});

describe('usage accounting', () => {
  it('converts usage into a budget delta using profile prices', async () => {
    const gateway = makeGateway();
    const budget = await gateway.usageToBudgetDelta(profile({ priceInPerM: 10, priceOutPerM: 30 }), {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(budget.usedTokens).toBe(2_000_000);
    expect(budget.usedCostCny).toBeCloseTo(40, 5);
  });
});
