import { assertBudget, type Budget, type ModelProfile } from '@creator-studio/protocol';
import { ModelError } from './errors.js';
import { createOpenAiAdapter } from './openai.js';
import { createAnthropicAdapter } from './anthropic.js';
import type {
  Adapter,
  ChatRequest,
  ModelDelta,
  ResolvedProfile,
  TaskRouting,
  Usage,
} from './types.js';

export type KeyResolver = (apiKeyRef: string) => Promise<string | null>;

export type GatewayOptions = {
  profiles: ModelProfile[];
  resolveKey: KeyResolver;
  routing?: TaskRouting | undefined;
  fetchImpl?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  maxRetries?: number | undefined;
  baseDelayMs?: number | undefined;
  maxDelayMs?: number | undefined;
};

export type ChatCallOptions = {
  profileId?: string;
  agentId?: string;
  budget?: Budget;
};

export type ChatOutcome = {
  deltas: AsyncGenerator<ModelDelta, void, unknown>;
};

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY = 400;
const DEFAULT_MAX_DELAY = 5_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokens(req: ChatRequest): number {
  const chars = req.messages.reduce((sum, message) => sum + message.content.length, 0);
  const toolChars = (req.tools ?? []).reduce(
    (sum, tool) => sum + tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length,
    0,
  );
  return Math.ceil((chars + toolChars) / 2);
}

function estimateCost(profile: ModelProfile, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * profile.priceInPerM + (outputTokens / 1_000_000) * profile.priceOutPerM;
}

function pickAdapter(profile: ModelProfile): Adapter {
  if (profile.provider === 'anthropic') return createAnthropicAdapter();
  return createOpenAiAdapter();
}

type ResolvedOptions = GatewayOptions & {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export class ModelGateway {
  private readonly adapters = new Map<string, Adapter>();
  private readonly options: ResolvedOptions;

  constructor(options: GatewayOptions) {
    this.options = {
      ...options,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY,
      maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY,
    };
  }

  listProfiles(): ModelProfile[] {
    return [...this.options.profiles];
  }

  resolveProfile(agentId: string | undefined, profileId: string | undefined): ModelProfile {
    const byRouting = agentId !== undefined ? this.options.routing?.[agentId as never] : undefined;
    const targetId = profileId ?? byRouting;
    if (targetId !== undefined) {
      const found = this.options.profiles.find((profile) => profile.id === targetId);
      if (found === undefined) {
        throw new ModelError('MODEL_UNAVAILABLE', `model profile not found: ${targetId}`);
      }
      return found;
    }
    const first = this.options.profiles[0];
    if (first === undefined) {
      throw new ModelError('MODEL_UNAVAILABLE', 'no model profiles configured');
    }
    return first;
  }

  async *chat(call: ChatCallOptions, req: ChatRequest): AsyncGenerator<ModelDelta, void, unknown> {
    const profile = this.resolveProfile(call.agentId, call.profileId);
    const apiKey = await this.options.resolveKey(profile.apiKeyRef);
    if (apiKey === null || apiKey === '') {
      throw new ModelError('MODEL_AUTH', `missing credential for ${profile.apiKeyRef}`);
    }

    const estimatedIn = estimateTokens(req);
    const estimatedOut = req.maxOutputTokens ?? 4096;

    if (call.budget !== undefined) {
      try {
        assertBudget(call.budget, { tokens: estimatedIn + estimatedOut, costCny: estimateCost(profile, estimatedIn, estimatedOut) });
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'BUDGET_EXCEEDED';
        throw new ModelError('BUDGET_EXCEEDED', `budget precheck failed: ${code}`);
      }
    }

    const resolved: ResolvedProfile = { profile, apiKey };
    const adapter = this.adapterFor(profile);
    const sleep = this.options.sleep ?? defaultSleep;

    let attempt = 0;
    let emittedAny = false;

    while (true) {
      try {
        for await (const delta of adapter.chat(
          { profile: resolved.profile, apiKey: resolved.apiKey, fetchImpl: this.options.fetchImpl },
          req,
        )) {
          emittedAny = true;
          yield delta;
        }
        return;
      } catch (error) {
        const modelError = toModelError(error);
        const canRetry = modelError.retryable && !emittedAny && attempt < this.options.maxRetries;
        if (!canRetry) throw modelError;
        const delay = Math.min(this.options.baseDelayMs * 2 ** attempt, this.options.maxDelayMs);
        attempt += 1;
        await sleep(delay);
      }
    }
  }

  async usageToBudgetDelta(profile: ModelProfile, usage: Usage): Promise<Budget> {
    return {
      maxTokens: 0,
      maxCostCny: 0,
      usedTokens: usage.inputTokens + usage.outputTokens,
      usedCostCny: estimateCost(profile, usage.inputTokens, usage.outputTokens),
    };
  }

  private adapterFor(profile: ModelProfile): Adapter {
    const cached = this.adapters.get(profile.provider);
    if (cached !== undefined) return cached;
    const adapter = pickAdapter(profile);
    this.adapters.set(profile.provider, adapter);
    return adapter;
  }
}

function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new ModelError('MODEL_TIMEOUT', 'request aborted', { retryable: false });
    }
    return new ModelError('MODEL_NETWORK', error.message, { retryable: true });
  }
  return new ModelError('MODEL_NETWORK', 'unknown failure', { retryable: false });
}
