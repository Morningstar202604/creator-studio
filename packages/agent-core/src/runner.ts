import {
  type AgentId,
  type Approval,
  type ApprovalKind,
  type Run,
  type RunEvent,
  type RunStore,
  type Step,
  type StoredMessage,
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
  signal?: AbortSignal | undefined;
};

export type ResumeInput = {
  runId: string;
  agentId: AgentId;
  /** Approval the user just granted; consumed before the pending tool runs. */
  approval?: Approval | undefined;
  signal?: AbortSignal | undefined;
};

export type RunOutcome =
  | { status: 'succeeded'; text: string; steps: number }
  | { status: 'waiting_approval'; approvalId: string; text: string; steps: number }
  | { status: 'failed'; code: string; message: string; steps: number }
  | { status: 'cancelled'; text: string; steps: number }
  | { status: 'paused'; reason: 'BUDGET_EXCEEDED' | 'MAX_STEPS'; text: string; steps: number };

const DEFAULT_MAX_STEPS = 16;

export class AgentRunner {
  constructor(private readonly ctx: RunContext) {}

  async run(input: RunInput): Promise<RunOutcome> {
    const { store } = this.ctx;
    const clock = this.ctx.now ?? (() => new Date());

    const agent = this.ctx.agents.find((candidate) => candidate.id === input.agentId);
    if (agent === undefined) {
      return { status: 'failed', code: 'UNKNOWN_AGENT', message: `no agent ${input.agentId}`, steps: 0 };
    }

    const run = store.getRun(input.runId);
    if (run === null) {
      return { status: 'failed', code: 'RUN_NOT_FOUND', message: input.runId, steps: 0 };
    }
    if (run.status === 'succeeded' || run.status === 'cancelled') {
      return { status: 'failed', code: 'RUN_TERMINAL', message: `run already ${run.status}`, steps: 0 };
    }

    const transcript: ChatMessage[] = [{ role: 'system', content: agent.systemPrompt }, ...input.messages];
    this.persistMessages(run.id, transcript, clock, 0);
    store.patchRun(run.id, { status: 'running', startedAt: run.startedAt ?? clock().toISOString(), endedAt: null });

    return this.loop(run, agent, transcript, this.nextStepIndex(run.id), '', input.signal, clock);
  }

  /**
   * Continues a run that paused for approval (or was interrupted). The stored
   * transcript is the source of truth: if the last assistant message still has
   * tool calls without results, those calls run first, then the model resumes.
   */
  async resume(input: ResumeInput): Promise<RunOutcome> {
    const { store } = this.ctx;
    const clock = this.ctx.now ?? (() => new Date());
    const agent = this.ctx.agents.find((candidate) => candidate.id === input.agentId);
    if (agent === undefined) {
      return { status: 'failed', code: 'UNKNOWN_AGENT', message: `no agent ${input.agentId}`, steps: 0 };
    }
    const run = store.getRun(input.runId);
    if (run === null) {
      return { status: 'failed', code: 'RUN_NOT_FOUND', message: input.runId, steps: 0 };
    }
    if (run.status === 'succeeded' || run.status === 'cancelled') {
      return { status: 'failed', code: 'RUN_TERMINAL', message: `run already ${run.status}`, steps: 0 };
    }

    // Keep the stored system row so transcript indexes stay aligned with the
    // persisted seq numbers; only its text is refreshed to the current prompt.
    const stored = store.listMessages(run.id);
    const transcript: ChatMessage[] = stored.map(toChatMessage);
    if (transcript[0]?.role === 'system') transcript[0] = { role: 'system', content: agent.systemPrompt };
    if (transcript.length === 0) {
      return this.run({ runId: run.id, agentId: agent.id, messages: [], ...(input.signal ? { signal: input.signal } : {}) });
    }

    const grants = this.ctx.grantsFor?.(agent.id) ?? [];
    let stepCount = this.nextStepIndex(run.id);
    let accumulatedText = transcript
      .filter((message) => message.role === 'assistant')
      .map((message) => message.content)
      .join('');

    store.patchRun(run.id, { status: 'running', startedAt: run.startedAt ?? clock().toISOString(), endedAt: null });

    const pending = pendingToolCalls(transcript);
    for (const { call, stepId } of pending) {
      stepCount += 1;
      const outcome = await this.executeOne(
        { ...run, status: 'running' },
        stepId,
        stepCount,
        call,
        transcript,
        grants,
        input.approval ?? null,
        clock,
      );
      if (outcome !== null) {
        const text = accumulatedText;
        store.patchRun(run.id, { status: 'waiting_approval' });
        return { status: 'waiting_approval', approvalId: outcome.approvalId, text, steps: stepCount };
      }
    }

    return this.loop(run, agent, transcript, stepCount, accumulatedText, input.signal, clock);
  }

  private async loop(
    run: Run,
    agent: AgentSpec,
    transcript: ChatMessage[],
    startSteps: number,
    startText: string,
    signal: AbortSignal | undefined,
    clock: () => Date,
  ): Promise<RunOutcome> {
    const { store } = this.ctx;
    const maxSteps = this.ctx.maxStepsPerRun ?? DEFAULT_MAX_STEPS;
    const toolSchemas = this.schemasFor(agent);
    const grants = this.ctx.grantsFor?.(agent.id) ?? [];

    let accumulatedText = startText;
    let stepCount = startSteps;

    while (stepCount < maxSteps) {
      if (isAborted(signal) || store.getRun(run.id)?.status === 'cancelled') {
        store.patchRun(run.id, { status: 'cancelled', endedAt: clock().toISOString() });
        this.emit(run.id, 'run.finished', { status: 'cancelled', steps: stepCount });
        return { status: 'cancelled', text: accumulatedText, steps: stepCount };
      }

      stepCount += 1;
      const stepId = `${run.id}_s${stepCount}`;
      this.createStep(stepId, run.id, stepCount, 'model');
      this.emit(run.id, 'step.started', { stepId, index: stepCount, kind: 'model' });

      let textThisStep = '';
      const toolCalls = new Map<string, ChatToolCall>();
      let usage: Usage | null = null;

      try {
        const stream = this.ctx.gateway.chat(
          { agentId: agent.id, budget: this.currentBudget(run.id) },
          {
            messages: transcript,
            ...(toolSchemas.length === 0 ? {} : { tools: toolSchemas }),
            ...(agent.maxOutputTokens === undefined ? {} : { maxOutputTokens: agent.maxOutputTokens }),
            ...(signal === undefined ? {} : { signal }),
          },
        );

        for await (const delta of stream) {
          if (isAborted(signal)) {
            this.finishStep(stepId, 'skipped');
            store.patchRun(run.id, { status: 'cancelled', endedAt: clock().toISOString() });
            this.emit(run.id, 'run.finished', { status: 'cancelled', steps: stepCount });
            return { status: 'cancelled', text: accumulatedText + textThisStep, steps: stepCount };
          }
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
        const assistant: ChatMessage = { role: 'assistant', content: textThisStep };
        transcript.push(assistant);
        this.persistMessages(run.id, [assistant], clock, transcript.length - 1);
        store.patchRun(run.id, { status: 'succeeded', endedAt: clock().toISOString() });
        this.emit(run.id, 'run.finished', { status: 'succeeded', steps: stepCount });
        return { status: 'succeeded', text: accumulatedText, steps: stepCount };
      }

      const calls = [...toolCalls.values()];
      const assistant: ChatMessage = { role: 'assistant', content: textThisStep, toolCalls: calls };
      transcript.push(assistant);
      this.persistMessages(run.id, [assistant], clock, transcript.length - 1);

      for (const call of calls) {
        const outcome = await this.executeOne(run, stepId, stepCount, call, transcript, grants, null, clock);
        if (outcome !== null) {
          return { status: 'waiting_approval', approvalId: outcome.approvalId, text: accumulatedText, steps: stepCount };
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
    provided: Approval | null,
    clock: () => Date,
  ): Promise<{ approvalId: string } | null> {
    const { store, toolHost } = this.ctx;
    const tool = toolHost.list().find((entry) => entry.name === call.name);
    const kind = (tool?.approvalKind ?? null) as ApprovalKind | null;
    const input = safeJson(call.argumentsJson);

    let approval: Approval | null = provided;
    if (kind !== null) {
      if (approval === null) {
        approval = await this.ctx.approvalProvider.request(kind, input, {
          runId: run.id,
          stepId,
          tool: call.name,
        });
      }
      if (approval === null) {
        const existing = store
          .listApprovals(run.id)
          .find((candidate) => candidate.decision === 'pending' && candidate.kind === kind);
        const approvalId = existing?.id ?? `${stepId}_${call.id}`;
        if (existing === undefined) {
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
            consumedAt: null,
          });
          this.emit(run.id, 'approval.requested', { stepId, tool: call.name, approvalId });
        }
        store.patchRun(run.id, { status: 'waiting_approval' });
        return { approvalId };
      }
      if (!store.consumeApproval(approval.id)) {
        this.emit(run.id, 'approval.requested', {
          stepId,
          tool: call.name,
          approvalId: approval.id,
          reason: 'APPROVAL_CONSUMED',
        });
        return { approvalId: approval.id };
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

    const toolMessage: ChatMessage = {
      role: 'tool',
      content: JSON.stringify(result.ok ? result.output : { error: result.code, message: result.message }),
      toolCallId: call.id,
      name: call.name,
    };
    transcript.push(toolMessage);
    this.persistMessages(run.id, [toolMessage], clock, transcript.length - 1);
    return null;
  }

  private persistMessages(runId: string, messages: ChatMessage[], clock: () => Date, startSeq = 0): void {
    const existing = this.ctx.store.listMessages(runId).length;
    messages.forEach((message, offset) => {
      const seq = startSeq + offset;
      if (seq < existing) return;
      const stored: StoredMessage = {
        id: `${runId}_m${seq}`,
        runId,
        seq,
        role: message.role,
        content: message.content,
        toolCallId: message.toolCallId ?? null,
        name: message.name ?? null,
        toolCalls: message.toolCalls ?? null,
        createdAt: clock().toISOString(),
      };
      try {
        this.ctx.store.appendMessage(stored);
      } catch {
        // Resume is best effort: a duplicate seq must not abort the live run.
      }
    });
  }

  private nextStepIndex(runId: string): number {
    const steps = this.ctx.store.listSteps(runId);
    return steps.length === 0 ? 0 : Math.max(...steps.map((step) => step.index));
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

function toChatMessage(message: StoredMessage): ChatMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCallId === null ? {} : { toolCallId: message.toolCallId }),
    ...(message.name === null ? {} : { name: message.name }),
    ...(message.toolCalls === null ? {} : { toolCalls: message.toolCalls }),
  };
}

/**
 * Tool calls in the last assistant message that have no matching tool result yet.
 * Step ids mirror the suffix the runner writes (`run_step`), so replay is traceable.
 */
export function pendingToolCalls(transcript: ChatMessage[]): Array<{ call: ChatToolCall; stepId: string }> {
  const lastAssistant = [...transcript].reverse().find((message) => message.role === 'assistant');
  if (lastAssistant?.toolCalls === undefined) return [];
  const answered = new Set(
    transcript.filter((message) => message.role === 'tool').map((message) => message.toolCallId),
  );
  const index = transcript.lastIndexOf(lastAssistant);
  return lastAssistant.toolCalls
    .filter((call) => !answered.has(call.id))
    .map((call) => ({ call, stepId: `resume_${index}` }));
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function safeJson(value: string): unknown {
  if (value.trim() === '') return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
