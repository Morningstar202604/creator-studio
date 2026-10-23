import type { AgentId, ModelProfile, Provider } from '@creator-studio/protocol';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatToolCall = {
  id: string;
  name: string;
  argumentsJson: string;
};

export type ChatMessage = {
  role: ChatRole;
  content: string;
  toolCallId?: string | undefined;
  name?: string | undefined;
  toolCalls?: ChatToolCall[] | undefined;
};

export type ToolSchema = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolSchema[] | undefined;
  temperature?: number | undefined;
  maxOutputTokens?: number | undefined;
  signal?: AbortSignal | undefined;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
};

export type ModelDelta =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; id: string; name: string; argumentsJson: string }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'done'; finishReason: 'stop' | 'length' | 'tool_calls' | 'error' };

export type AdapterContext = {
  profile: ModelProfile;
  apiKey: string;
  fetchImpl?: typeof fetch | undefined;
};

export type Adapter = {
  provider: Provider;
  chat(ctx: AdapterContext, req: ChatRequest): AsyncGenerator<ModelDelta, void, unknown>;
};

export type ResolvedProfile = {
  profile: ModelProfile;
  apiKey: string;
};

export type TaskRouting = Partial<Record<AgentId, string>>;
