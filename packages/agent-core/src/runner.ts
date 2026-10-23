import {
  type AgentId,
  type Approval,
  type ApprovalKind,
  type Run,
  type RunEvent,
  type RunStore,
  type Step,
} from '@creator-studio/protocol';
import {
  ModelError,
  type ChatMessage,
  type ChatToolCall,
  type ModelGateway,
  type ToolSchema,
  type Usage,
} from '@creator-studio/model-gateway';
import type { ToolHost } from '@creator-studio/tools';

export type AgentSpec = {
  id: AgentId;
  systemPrompt: string;
  tools: string[];
  maxOutputTokens?: number | undefined;
};

export type ApprovalRequestContext = { runId: string; stepId: string; tool: string };

export type ApprovalProvider = {
  /** Resolve an approval for this tool call; return null to pause the run. */
  request(kind: ApprovalKind, payload: unknown, ctx: ApprovalRequestContext): Promise<Approval | null>;
};

export type RunContext = {
  store: RunStore;
  gateway: ModelGateway;
  toolHost: ToolHost;
  agents: AgentSpec[];
  approvalProvider: ApprovalProvider;
  workspaceRoot: string;
  deviceId: string;
  now?: (() => Date) | undefined;
  maxStepsPerRun?: number | undefined;
  grantsFor?: ((agentId: AgentId) => import('@creator-studio/protocol').ToolGrant[]) | undefined;
};

export type RunInput = {
  runId: string;
  agentId: AgentId;
  messages: ChatMessage[];
};

export type RunOutcome =
  | { status: 'succeeded'; text: string; steps: number }
  | { status: 'waiting_approval'; approvalId: string; text: string; steps: number }
  | { status: 'failed'; code: string; message: string; steps: number }
  | { status: 'paused'; reason: 'BUDGET_EXCEEDED' | 'MAX_STEPS'; text: string; steps: number };

const DEFAULT_MAX_STEPS = 12;

export class AgentRunner {
  constructor(private readonly ctx: RunContext) {}

  async run(input: RunInput): Promise<RunOutcome> {
    const { store, gateway, toolHost } = this.ctx;
    const clock = this.ctx.now ?? (() => new Date());
    const maxSteps = this.ctx.maxStepsPerRun ?? DEFAULT_MAX_STEPS;

    const agent = this.ctx.agents.find((candidate) => candidate.id === input.agentId);
    if (agent === undefined) {
      return { status: 'failed', code: 'UNKNOWN_AGENT', message: `no agent ${input.agentId}`, steps: 0 };
    }

    const run = store.getRun(input.runId);
    if (run === null) {
      return { status: 'failed', code: 'RUN_NOT_FOUND', message: input.runId, steps: 0 };
    }

    if (run.status === 'queued') {
      store.patchRun(run.id, { status: 'running', startedAt: clock().toISOString() });
    }

    const toolSchemas: ToolSchema[] = this.schemasFor(agent);
    const transcript: ChatMessage[] = [{ role: 'system', content: agent.systemPrompt }, ...input.messages];

    let accumulatedText = '';
    let stepCount = 0;
    const grants = this.ctx.grantsFor?.(agent.id) ?? [];

    while (stepCount < maxSteps) {
      stepCount += 1;
      const stepId = `${run.id}_s${stepCount}`;
      this.createStep(stepId, run.id, stepCount, 'model');
      this.emit(run.id, 'step.started', { stepId, index: stepCount, kind: 'model' });

      let textThisStep = '';
      const toolCalls = new Map<string, ChatToolCall>();
      let usage: Usage | null = null;

      try {
        const stream = gateway.chat(
          { agentId: agent.id, budget: this.currentBudget(run.id) },
          {
            messages: transcript,
            ...(toolSchemas.length === 0 ? {} : { tools: toolSchemas }),
            ...(agent.maxOutputTokens === undefined ? {} : { maxOutputTokens: agent.maxOutputTokens }),
          },
        );

        for await (const delta of stream) {
          if (delta.kind === 'text') textThisStep += delta.text;
          else if (delta.kind === 'usage') usage = delta.usage;
          else if (delta.kind === 'tool_call') {
            const existing = toolCalls.get(delta.id);
            if (existing === undefined) {
              toolCalls.set(delta.id, {
                id: delta.id,
                name: delta.name,
                argumentsJson: delta.argumentsJson,
              });
            } else {
              existing.argumentsJson += delta.argumentsJson;
              if (delta.name !== '') existing.name = delta.name;
            }
          }
        }
      } catch (error) {
        const modelError = error instanceof ModelError ? error : null;
        const code = modelError?.code ?? 'MODEL_ERROR';
        const message = modelError?.message ?? String(error);

        if (code === 'BUDGET_EXCEEDED') {
          this.finishStep(stepId, 'skipped');
          store.patchRun(run.id, { status: 'paused' });
          this.emit(run.id, 'budget.warning', { code, step: stepCount });
          return { status: 'paused', reason: 'BUDGET_EXCEEDED', text: accumulatedText, steps: stepCount };
        }

        this.finishStep(stepId, 'failed');
        store.patchRun(run.id, {
          status: 'failed',
          endedAt: clock().toISOString(),
          error: { code, message, retryable: modelError?.retryable ?? false },
        });
        this.emit(run.id, 'error', { code, step: stepCount });
        return { status: 'failed', code, message, steps: stepCount };
      }

      if (usage !== null) {
        const cost = this.costOf(run, usage);
        try {
          store.addBudgetUsage(run.id, { tokens: usage.inputTokens + usage.outputTokens, costCny: cost });
        } catch {
          this.finishStep(stepId, 'succeeded');
          store.patchRun(run.id, { status: 'paused' });
          this.emit(run.id, 'budget.warning', { code: 'BUDGET_EXCEEDED', step: stepCount });
          return { status: 'paused', reason: 'BUDGET_EXCEEDED', text: accumulatedText, steps: stepCount };
        }
      }

      accumulatedText += textThisStep;
      this.finishStep(stepId, 'succeeded');
      this.emit(run.id, 'step.finished', {
        stepId,
        index: stepCount,
        status: 'succeeded',
        toolCalls: toolCalls.size,
      });

      if (toolCalls.size === 0) {
        store.patchRun(run.id, { status: 'succeeded', endedAt: clock().toISOString() });
        this.emit(run.id, 'run.finished', { status: 'succeeded', steps: stepCount });
        return { status: 'succeeded', text: accumulatedText, steps: stepCount };
      }

      const calls = [...toolCalls.values()];
      transcript.push({ role: 'assistant', content: textThisStep, toolCalls: calls });

      for (const call of calls) {
        const paused = await this.executeOne(run, stepId, stepCount, call, transcript, grants, clock);
        if (paused !== null) {
          return { ...paused, text: accumulatedText, steps: stepCount };
        }
      }
    }

    store.patchRun(run.id, { status: 'paused' });
    this.emit(run.id, 'budget.warning', { reason: 'MAX_STEPS' });
    return { status: 'paused', reason: 'MAX_STEPS', text: accumulatedText, steps: stepCount };
  }

  private async executeOne(
    run: Run,
    stepId: string,
    stepIndex: number,
    call: ChatToolCall,
    transcript: ChatMessage[],
    grants: import('@creator-studio/protocol').ToolGrant[],
    clock: () => Date,
  ): Promise<Extract<RunOutcome, { status: 'waiting_approval' }> | null> {
    const { store, toolHost } = this.ctx;
    const tool = toolHost.list().find((entry) => entry.name === call.name);
    const kind = (tool?.approvalKind ?? null) as ApprovalKind | null;
    const input = safeJson(call.argumentsJson);

    let approval: Approval | null = null;
    if (kind !== null) {
      approval = await this.ctx.approvalProvider.request(kind, input, {
        runId: run.id,
        stepId,
        tool: call.name,
      });
      if (approval === null) {
        const approvalId = `${stepId}_${call.id}`;
        store.createApproval({
          id: approvalId,
          runId: run.id,
          stepId,
          kind,
          payload: input,
          decision: 'pending',
          requestedAt: clock().toISOString(),
          decidedAt: null,
          decidedBy: null,
        });
        store.patchRun(run.id, { status: 'waiting_approval' });
        this.emit(run.id, 'approval.requested', { stepId, tool: call.name });
        return { status: 'waiting_approval', approvalId, text: '', steps: stepIndex };
      }
    }

    this.emit(run.id, 'tool.called', { tool: call.name, step: stepIndex });

    const result = await toolHost.execute({
      name: call.name,
      input,
      context: {
        deviceId: this.ctx.deviceId,
        runId: run.id,
        workspaceRoot: this.ctx.workspaceRoot,
        grants,
        approval,
      },
    });

    this.emit(run.id, 'tool.result', { tool: call.name, ok: result.ok });

    transcript.push({
      role: 'tool',
      content: JSON.stringify(result.ok ? result.output : { error: result.code, message: result.message }),
      toolCallId: call.id,
      name: call.name,
    });

    return null;
  }

  private schemasFor(agent: AgentSpec): ToolSchema[] {
    const available = this.ctx.toolHost.list();
    return agent.tools
      .map((name) => available.find((tool) => tool.name === name))
      .filter((tool): tool is { name: string; risk: string; approvalKind: string | null } => tool !== undefined)
      .map((tool) => ({
        name: tool.name,
        description: `${tool.name} (${tool.risk} risk)`,
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      }));
  }

  private currentBudget(runId: string): import('@creator-studio/protocol').Budget {
    const run = this.ctx.store.getRun(runId);
    if (run === null) throw new Error('RUN_NOT_FOUND');
    return run.budget;
  }

  private costOf(run: Run, usage: Usage): number {
    const profile = this.ctx.gateway.listProfiles().find((candidate) => candidate.id === run.modelProfileId);
    if (profile === undefined) return 0;
    return (
      (usage.inputTokens / 1_000_000) * profile.priceInPerM +
      (usage.outputTokens / 1_000_000) * profile.priceOutPerM
    );
  }

  private createStep(stepId: string, runId: string, index: number, kind: Step['kind']): void {
    const step: Step = {
      id: stepId,
      runId,
      index,
      kind,
      status: 'running',
      toolName: null,
      toolArgs: null,
      resultRef: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.ctx.store.createStep(step);
  }

  private finishStep(stepId: string, status: 'succeeded' | 'failed' | 'skipped'): void {
    this.ctx.store.patchStep(stepId, { status, endedAt: new Date().toISOString() });
  }

  private emit(runId: string, type: RunEvent['type'], payload: unknown): void {
    const store = this.ctx.store;
    const seq = store.nextEventSeq(runId);
    store.appendEvent({
      id: `${runId}_e${seq}`,
      runId,
      seq,
      type,
      payload,
      ts: new Date().toISOString(),
    });
  }
}

function safeJson(value: string): unknown {
  if (value.trim() === '') return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
