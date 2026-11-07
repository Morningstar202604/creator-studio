# Agent harness landscape

What other agent runtimes do, what this project does, and which gaps are real.
Written after reading the repositories rather than their READMEs: stars, licences
and descriptions come from the GitHub API on 2026-11-04, mechanisms from the code.

## Why this matters

A "harness" is everything around the model: how a tool is described, how a run is
paused, how state survives a crash, how a client renders progress. Getting these
wrong does not make the demo fail — it makes the product fail after a week of use,
when a run dies at step nine and nothing can be resumed.

## Reference projects

| Project | Stars | Licence | What it is | What we took |
|---|---:|---|---|---|
| langchain-ai/langgraph | 44.4k | MIT | Durable agent graphs | Persistence as a first-class idea: a run is a row, not a promise |
| openai/openai-agents-python | 30.5k | MIT | Lightweight multi-agent SDK | Handoffs as tools; guardrails that fail fast |
| langgenius/dify | 160k | Modified Apache | Visual agent/workflow platform | Scenario-as-data; a workflow is editable without a deploy |
| n8n-io/n8n | 209k | Sustainable Use | Visual automation | Node graph mental model; retry with backoff per node |
| All-Hands-AI/OpenHands | 92.6k | MIT | AI dev environment | Approval-gated execution with a visible event stream |
| modelcontextprotocol/servers | 91.8k | MIT | MCP reference servers | Tool annotations: readOnly / destructive / idempotent / openWorld |
| ag-ui-protocol/ag-ui | 17.0k | MIT | Agent↔UI event protocol | Lifecycle event vocabulary (31 event types) |
| a2aproject/A2A | 26.4k | Apache-2.0 | Agent↔agent protocol | Agent Card discovery; task state machine |
| microsoft/autogen | 61.7k | CC-BY-4.0 | Multi-agent conversation | Typed message passing between agents |
| crewAIInc/crewAI | 60.5k | MIT | Role-based agent crews | Role/capability declarations per agent |
| run-llama/llama_index | 52.8k | MIT | Document processing | Chunk + embed + retrieve as separate, testable stages |
| anthropics/claude-cookbooks | 54.1k | MIT | Prompt recipes | Output contracts before free-form prompts |

## The four layers, and where this project sits

The ecosystem has converged on four layers, each with its own standard:

```
agent ↔ tools/data      MCP           we implement the tool half
agent ↔ agent           A2A           we publish an Agent Card
agent ↔ user            AG-UI         we use its event names
agent ↔ observation     OpenTelemetry we do not implement it
```

### MCP — tools and data

MCP standardises how a model calls a tool: a JSON-RPC client/server split, with
`tools`, `resources` and `prompts` offered by the server and `sampling`, `roots`
and `elicitation` offered by the client.

**What we already had:** a tool registry with `name`, `risk` and `approvalKind`,
path sandboxing, grants and an audit log. That is the enforcement half.

**What we were missing:** the description half. MCP's `ToolAnnotations` are hints a
client uses to decide how careful to be — `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`. Without them a UI cannot tell "read a file" from
"delete a file" without hardcoding tool names.

**Now:** every built-in tool declares `annotations`, and `/v1/tools` passes them
through verbatim. A client that already understands MCP can reason about our tools
with no custom mapping.

**Not done, deliberately:** we were not an MCP server or client. That is a protocol
boundary with its own transport (stdio, streamable HTTP), session lifecycle and
capability negotiation. Claiming MCP compliance without it would be worse than
being honest about where we are.

**Since 0.19.1:** the daemon **is an MCP server**. `POST /mcp` speaks Streamable
HTTP, stateless per the 2026-07-28 spec (fresh server + transport per request, no
session ids). Ten consolidated tools cover the whole studio surface —
`list_projects`, `get_project`, `list_scenarios`, `create_project`,
`list_artifacts`, `read_artifact`, `generate_artifact`, `run_agent`,
`publish_pack`, `search_memory` — and each call re-enters the daemon's own HTTP
API over loopback, so MCP clients inherit the same validation, approval gating,
audit trail and revision checks the first-party clients get. There is no second,
weaker code path. Verified by `apps/daemon/test/mcp.test.ts` (protocol handshake,
tool listing, real calls) and an external check with the official SDK client.
Still not done: we are not an MCP *client*, and the endpoint does not offer
`resources`/`prompts` yet — the tool surface is what hosts actually drive.

### A2A — agent to agent

A2A defines an **Agent Card** at a well-known URL: name, version, capabilities,
skills, transports. A client reads one document and knows whether it can talk to
the agent and how.

**What we had:** nothing. Another agent had to read our source.

**Now:** `GET /.well-known/agent-card.json` returns name, version, protocolVersion,
capabilities, three skills (generate-artifact, run-agent, export-package) and the
transport list. `security: []` because we have no auth — advertising a scheme the
daemon does not enforce would be a lie a client might rely on.

**Not done:** we do not implement A2A's task lifecycle (SUBMITTED → WORKING →
COMPLETED). Our runs have their own state machine. Mapping the two is real work and
was not faked.

### AG-UI — agent to user

AG-UI fixes the event vocabulary between an agent and its UI: 31 event types for
text streaming, tool calls, state snapshots, reasoning, sub-agents.

**What we had:** eight internal event types (`step.started`, `tool.called`, …)
delivered over SSE. Functional, but nothing outside our codebase could parse it.

**Now:** lifecycle events carry AG-UI's names on the wire — `STEP_STARTED`,
`STEP_FINISHED`, `TOOL_CALL_START`, `TOOL_CALL_RESULT`, `RUN_FINISHED`, `RUN_ERROR`
— while the payload still carries the internal `type`, so existing consumers keep
working. Events with no AG-UI equivalent (`approval.requested`, `budget.warning`)
keep their own names: inventing a standard name that does not exist is worse than
an honest custom one.

**Still missing against the full spec:** `TEXT_MESSAGE_CONTENT` for token-level
streaming, `STATE_SNAPSHOT`/`STATE_DELTA` for shared state, `REASONING_*` for
visible thinking, `SUBAGENT_*` for delegated work. These need changes to how the
agent loop emits, not just a rename.

### OpenTelemetry — observation

The GenAI semantic conventions define `gen_ai.*` attributes: request model,
token usage, operation name, response finish reason.

**What we have:** a per-run audit log with tool target, decision, duration and
outcome; token and cost accounting per run.

**What this gives that OTel would too:** you can answer "what did this run do" and
"what did it cost".

**What is missing:** span export. Our records live in SQLite and are visible
through `/v1/audit` and the UI, but they do not go anywhere a standard collector
can read. Adding an OTLP exporter is a real, bounded piece of work — it is listed
in the roadmap rather than faked with an attribute naming convention.

## Mechanisms worth stealing, in priority order

1. **Durable run as a row** (LangGraph). We have this: runs persist, crashes mark
   them `INTERRUPTED`, approvals resume. The scheduler's double-dispatch bug this
   release was the same class of problem, and it is fixed.
2. **Guardrails that fail fast** (OpenAI Agents SDK). We have artifact contracts
   and one corrective retry. What we lack is a pre-flight check on inputs; a bad
   context currently costs a model round trip.
3. **Handoffs as tools** (OpenAI Agents SDK). Our agents cannot call each other.
   Every stage is a separate generation. This is a real capability gap, not a
   naming gap, and it needs a design.
4. **Per-node retry policy** (n8n). We retry the model call, not the pipeline step.
5. **Chunk/embed/retrieve as separate stages** (LlamaIndex). We have this in
   `memory-index`, including a migration that fixed kind filtering.
6. **Role declarations** (CrewAI). Our eight agents declare allowed tools; they do
   not declare capabilities a router could match on.

## What was NOT added, and why

| Thing | Why not |
|---|---|
| MCP server/client transport | Weeks of protocol work; a half-implementation is a compatibility trap |
| A2A task lifecycle | Our run states do not map 1:1; mapping needs a design, not a rename |
| OTel exporter | Worth doing, but it is a new deployment surface (collector config, sampling); belongs in its own release |
| Token-level streaming | Requires the agent loop to emit deltas; the UI currently renders whole steps |
| Agent handoffs | Needs a delegation model and a loop-guard design |

Each of these is listed in [`ROADMAP.md`](ROADMAP.md) rather than claimed as done.
The rule from `AGENTS.md` applies: a capability you cannot demonstrate is not a
capability.

## Measured comparison

| Capability | Creator Studio | Dify | n8n | OpenHands | Codex-style harness |
|---|---|---|---|---|---|
| Scenario/pipeline as data | yes (JSON packs) | yes (visual) | yes (visual) | no | no |
| Local-first storage | yes (SQLite) | Postgres | Postgres | yes | yes |
| Approval-gated tools | yes (per-tool, single use) | partial | no | yes | yes |
| Resumable runs | yes | yes | yes | yes | yes |
| Tool annotations (MCP) | yes | partial | no | no | yes |
| MCP server endpoint | yes (`POST /mcp`, 10 tools) | no | no | no | no |
| Agent Card (A2A) | yes | no | no | no | no |
| AG-UI event names | partial | no | no | no | no |
| OTLP export | no | yes | yes | partial | no |
| Token-level streaming | no | yes | n/a | yes | yes |
| Multi-agent handoff | no | yes | partial | yes | yes |

The pattern is clear: we are strong exactly where the others are weak (scenario
packs, local-first, approval granularity, agent discovery) and weak where they are
strong (streaming granularity, tracing export, delegation). That is a reasonable
position for a focused product; pretending otherwise would not be.
