import type { Database } from 'better-sqlite3';
import {
  GrantModeSchema,
  ModelProfileSchema,
  ProviderSchema,
  type GrantMode,
  type ModelProfile,
  type Provider,
  type ToolGrant,
} from '@creator-studio/protocol';

type ModelRow = {
  id: string;
  user_id: string;
  name: string;
  provider: string;
  base_url: string;
  model: string;
  api_key_ref: string;
  context_window: number;
  price_in_per_m: number;
  price_out_per_m: number;
  is_local: number;
};

type GrantRow = {
  id: string;
  device_id: string;
  tool: string;
  scope: string;
  mode: string;
};

export type ModelInput = {
  id: string;
  name: string;
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKeyRef: string;
  contextWindow: number;
  priceInPerM: number;
  priceOutPerM: number;
  isLocal: boolean;
};

export type BudgetSettings = {
  monthlyCostCny: number;
  perProjectCostCny: number;
  warnAtPercent: number;
};

export const DEFAULT_BUDGET: BudgetSettings = {
  monthlyCostCny: 50,
  perProjectCostCny: 5,
  warnAtPercent: 80,
};

function toModel(row: ModelRow): ModelProfile {
  return ModelProfileSchema.parse({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    provider: ProviderSchema.parse(row.provider),
    baseUrl: row.base_url,
    model: row.model,
    apiKeyRef: row.api_key_ref,
    contextWindow: row.context_window,
    priceInPerM: row.price_in_per_m,
    priceOutPerM: row.price_out_per_m,
    isLocal: row.is_local === 1,
  });
}

function toGrant(row: GrantRow): ToolGrant {
  return {
    id: row.id,
    deviceId: row.device_id,
    tool: row.tool,
    scope: row.scope,
    mode: GrantModeSchema.parse(row.mode),
  };
}

export class SqliteSettingsStore {
  constructor(
    private readonly db: Database,
    private readonly userId = 'local-user',
  ) {}

  listModels(): ModelProfile[] {
    const rows = this.db
      .prepare('SELECT * FROM model_profiles WHERE user_id = ? ORDER BY name ASC')
      .all(this.userId) as ModelRow[];
    return rows.map(toModel);
  }

  upsertModel(input: ModelInput): ModelProfile {
    const profile: ModelProfile = ModelProfileSchema.parse({ ...input, userId: this.userId });
    this.db
      .prepare(
        `INSERT INTO model_profiles (id, user_id, name, provider, base_url, model, api_key_ref,
           context_window, price_in_per_m, price_out_per_m, is_local)
         VALUES (@id, @user_id, @name, @provider, @base_url, @model, @api_key_ref,
           @context_window, @price_in_per_m, @price_out_per_m, @is_local)
         ON CONFLICT(id) DO UPDATE SET
           name = @name, provider = @provider, base_url = @base_url, model = @model,
           api_key_ref = @api_key_ref, context_window = @context_window,
           price_in_per_m = @price_in_per_m, price_out_per_m = @price_out_per_m, is_local = @is_local`,
      )
      .run({
        id: profile.id,
        user_id: profile.userId,
        name: profile.name,
        provider: profile.provider,
        base_url: profile.baseUrl,
        model: profile.model,
        api_key_ref: profile.apiKeyRef,
        context_window: profile.contextWindow,
        price_in_per_m: profile.priceInPerM,
        price_out_per_m: profile.priceOutPerM,
        is_local: profile.isLocal ? 1 : 0,
      });
    return profile;
  }

  deleteModel(id: string): void {
    this.db.prepare('DELETE FROM model_profiles WHERE id = ? AND user_id = ?').run(id, this.userId);
  }

  listGrants(deviceId: string): ToolGrant[] {
    const rows = this.db
      .prepare('SELECT * FROM tool_grants WHERE device_id = ? ORDER BY tool ASC')
      .all(deviceId) as GrantRow[];
    return rows.map(toGrant);
  }

  setGrantMode(deviceId: string, tool: string, mode: GrantMode): void {
    const existing = this.db
      .prepare('SELECT id FROM tool_grants WHERE device_id = ? AND tool = ? AND scope = ?')
      .get(deviceId, tool, '**') as { id: string } | undefined;
    if (existing === undefined) {
      this.db
        .prepare('INSERT INTO tool_grants (id, device_id, tool, scope, mode) VALUES (?, ?, ?, ?, ?)')
        .run(`${deviceId}:${tool}:**`, deviceId, tool, '**', mode);
      return;
    }
    this.db.prepare('UPDATE tool_grants SET mode = ? WHERE id = ?').run(mode, existing.id);
  }

  getBudget(): BudgetSettings {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('budget') as
      | { value: string }
      | undefined;
    if (row === undefined) return { ...DEFAULT_BUDGET };
    const parsed = JSON.parse(row.value) as Partial<BudgetSettings>;
    return {
      monthlyCostCny: parsed.monthlyCostCny ?? DEFAULT_BUDGET.monthlyCostCny,
      perProjectCostCny: parsed.perProjectCostCny ?? DEFAULT_BUDGET.perProjectCostCny,
      warnAtPercent: parsed.warnAtPercent ?? DEFAULT_BUDGET.warnAtPercent,
    };
  }

  setBudget(value: BudgetSettings): BudgetSettings {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('budget', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(value), new Date().toISOString());
    return value;
  }

  /** Model profile used for embeddings; null means "probe the active chat model". */
  getEmbeddingModel(): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('embeddingModel') as
      | { value: string }
      | undefined;
    if (row === undefined) return null;
    const parsed = JSON.parse(row.value) as { modelId?: unknown };
    return typeof parsed.modelId === 'string' && parsed.modelId !== '' ? parsed.modelId : null;
  }

  setEmbeddingModel(modelId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('embeddingModel', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify({ modelId }), new Date().toISOString());
  }

  isOnboarded(): boolean {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('onboarding') as
      | { value: string }
      | undefined;
    if (row === undefined) return false;
    const parsed = JSON.parse(row.value) as { completed?: boolean };
    return parsed.completed === true;
  }

  setOnboarded(value: boolean): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('onboarding', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify({ completed: value }), new Date().toISOString());
  }
}
