import { randomUUID } from 'node:crypto';
import type { Artifact, ArtifactKind, GenerateKind } from '@creator-studio/protocol';
import type { ModelGateway } from '@creator-studio/model-gateway';
import type { SqliteArtifactStore } from '@creator-studio/store-sqlite';
import { fenceUntrusted } from '@creator-studio/tools';
import { jsonInstruction } from '@creator-studio/model-gateway';

import {
  EXAMPLES,
  PROMPTS,
  UPSTREAM,
  artifactPathFor,
  buildUpstreamContext,
  parseGenerated,
  renderMarkdown,
  repairPrompt,
} from './generate.js';

export type GenerateDeps = {
  gateway: ModelGateway;
  artifactStore: SqliteArtifactStore;
  workspaceRoot: string;
};

export type GenerateInput = {
  projectId: string;
  kind: GenerateKind;
  context: string;
  includeUpstream?: boolean;
  agentId?: string;
  /** Called once per model call with real usage so the caller can bill the stage. */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
};

export type GenerateResult = {
  artifact: Artifact;
  payload: unknown;
};

export class ModelOutputError extends Error {
  readonly code = 'MODEL_BAD_OUTPUT';
}

/** Every artifact lives under `projects/<projectId>/` so two projects cannot collide. */
export async function generateArtifact(deps: GenerateDeps, input: GenerateInput): Promise<GenerateResult> {
  const prompt = PROMPTS[input.kind];
  const includeUpstream = input.includeUpstream !== false;

  let upstreamText = '';
  if (includeUpstream) {
    const docs: Array<{ kind: string; content: string }> = [];
    for (const upstreamKind of UPSTREAM[input.kind]) {
      const latest = deps.artifactStore.latest(input.projectId, upstreamKind as ArtifactKind);
      if (latest !== null) docs.push({ kind: upstreamKind, content: latest.content });
    }
    upstreamText = buildUpstreamContext(docs, fenceUntrusted);
  }

  const base = prompt.user(input.context);
  const withUpstream =
    upstreamText === ''
      ? base
      : `${base}

以下是本项目的上游产物，请在此基础上继续：

${upstreamText}`;
  const userContent = jsonInstruction(withUpstream);

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: userContent },
  ];

  let payload: unknown = null;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let raw = '';
    for await (const delta of deps.gateway.chat(
      { agentId: input.agentId ?? 'scriptwriter' },
      {
        messages,
        maxOutputTokens: 4096,
        temperature: attempt === 0 ? 0.6 : 0.2,
      },
    )) {
      if (delta.kind === 'text') raw += delta.text;
      else if (delta.kind === 'usage') input.onUsage?.(delta.usage);
    }

    try {
      payload = parseGenerated(input.kind, raw);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === 0) {
        // One corrective retry with a literal example beats failing the whole stage.
        messages.push({ role: 'user', content: repairPrompt(EXAMPLES[input.kind], lastError) });
      }
    }
  }

  if (payload === null) {
    throw new ModelOutputError(`MODEL_BAD_OUTPUT: ${lastError}`);
  }

  const version = deps.artifactStore.nextVersion(input.projectId, input.kind, input.kind);
  const relative = artifactPathFor(input.kind, version);
  const markdown = renderMarkdown(input.kind, payload);
  const artifact = deps.artifactStore.save({
    id: randomUUID(),
    projectId: input.projectId,
    runId: null,
    kind: input.kind,
    path: relative,
    content: markdown,
    mime: 'text/markdown',
  });

  return { artifact, payload };
}
