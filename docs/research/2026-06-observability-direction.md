# Observability Direction for `claude-code-chat-explorer`

**Date:** 2026-06-03
**Status:** Strategic research (decision-grade). Not an implementation plan.
**Author:** research pass for the project owner.

> **Thesis under evaluation:** evolve this tool from a transcript search index into an
> **observability platform for agentic coding**, with **raw transcripts as the golden source**,
> eventually spanning **search + observability across multiple agentic coding harnesses**
> (Claude Code, Cursor, Cline, Aider, Codex CLI, Gemini CLI, Copilot, etc.).

**How to read this doc.** Claims are tagged **[verified]** (checked against a primary source cited in
References), **[inferred]** (reasoned from verified facts), or **[observed]** (seen directly in this
repo or in local `~/.claude` transcripts on the author's machine). Section 6 is the recommendation.

---

## 0. What this project extracts today (baseline) [observed]

From the current source (`src/analytics/core/ConversationAnalyzer.js`,
`src/analytics/data/DatabaseManager.js`, `Indexer.js`):

- **Storage:** SQLite via `better-sqlite3`. Tables: `conversations` (id, file_path, project, cwd,
  message_count, file_size, last_modified, created, `tokens_total/input/output`, `primary_model`,
  subagent columns `parent_id`/`is_subagent`), `tool_usage` (conversation_id, tool_name, call_count),
  `file_index` (incremental mtime/size cache), and an FTS5 virtual table `conversation_fts`
  (content, project) with `unicode61` tokenizer.
- **Granularity:** per-**conversation/session** aggregate, not per-message or per-request. Tool usage is a
  per-(conversation, tool) count, not an ordered event stream.
- **Tokens/cost:** sums `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, and the `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`
  split. Captures `service_tier`. Cost routing per-model lives in `src/utils/ModelPricing.js` (added in PR #6).
- **Search corpus:** FTS now indexes message text, `[THINKING]`, `[SYSTEM]`, `[SUMMARY]`, `[TOOL:<name>]`
  inputs, and `[TOOL_RESULT]` content (FTS `user_version` 2, PRs #5/#7). Per-block cap 256 KB.
- **Live:** `FileWatcher` + WebSocket push for incremental reindex; watcher health surfaced (PR #4).
- **Subagents:** `AgentAnalyzer` reconstructs Task-tool subagent trees via `parent_id`.

The owner's "per-message granularity with role/tool tagging" work is the natural bridge from this
session-level model toward an event/observability model.

---

## 1. Landscape of agentic-coding / LLM observability

There are four capture points in any agentic-coding stack, and every tool/product sits at one or more:

| Capture point | What it sees | What it cannot see |
|---|---|---|
| **(A) Transcript / on-disk session log** | Full conversation, tool calls + results, models, token usage as reported back, file edits, thinking | Wall-clock latency per request, retries, HTTP status, streaming timing, request/response headers |
| **(B) Harness-native telemetry (OTel)** | Spans/metrics/events the harness chooses to emit: durations, token/cost counters, tool decisions, errors | Only what the vendor instruments; content is opt-in/redacted; cardinality-limited |
| **(C) Hooks (PreToolUse/PostToolUse/Stop/...)** | Lifecycle events at the moment they happen, with the transcript path; can run arbitrary code | No model-internal timing; you build your own schema |
| **(D) Gateway / proxy (LiteLLM, OpenRouter, Cloudflare AI Gateway)** | The literal HTTP request/response to the model provider: real latency, retries, cache hits, headers, cost | The agent's *intent* and orchestration (which tool, which subagent) unless the harness passes metadata |

### 1.1 OpenTelemetry GenAI semantic conventions (the lingua franca) [verified]

OTel defines GenAI conventions across **spans, metrics, and events** (still "Development"/experimental;
gated behind `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`).

- **Spans** (`opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/`): a model call span named
  `{gen_ai.operation.name} {gen_ai.request.model}` (e.g. `chat gpt-4`), kind `CLIENT`. Key attrs:
  `gen_ai.provider.name`, `gen_ai.operation.name` (`chat`/`generate_content`/`embeddings`/`execute_tool`/
  `invoke_agent`/`invoke_workflow`/...), `gen_ai.request.model`, `gen_ai.response.model/id`,
  `gen_ai.usage.input_tokens/output_tokens`, `gen_ai.response.finish_reasons`. Content
  (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`,
  `gen_ai.tool.definitions`) is **Opt-In** and follows fixed JSON schemas.
- **Tool execution span** (`execute_tool {gen_ai.tool.name}`, kind `INTERNAL`): `gen_ai.tool.name`,
  `gen_ai.tool.call.id`, `gen_ai.tool.type` (`function`/`extension`/`datastore`),
  `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`.
- **Agent / workflow spans** (`gen-ai-agent-spans.md`): `create_agent`, `invoke_agent` (client/internal),
  `invoke_workflow` — this is exactly the shape of a Claude Code subagent tree.
- **Metrics** (`gen-ai-metrics/`): `gen_ai.client.token.usage` (histogram),
  `gen_ai.client.operation.duration`, `gen_ai.client.operation.time_to_first_chunk`,
  `gen_ai.client.operation.time_per_output_chunk`; server-side TTFT/TPOT.
- **Events** (`gen-ai-events/`): `gen_ai.client.inference.operation.details` (opt-in full request detail),
  `gen_ai.evaluation.result` (eval score/label/explanation) — useful if we ever attach evals.
- **MCP** has its own semconv page.

**Why it matters for us:** OTel GenAI is the *only* cross-vendor normalized model. If we want to unify
harnesses, our internal event/state model should be **OTel-GenAI-shaped** (operation.name, provider.name,
model, token usage, tool name/args/result, agent/workflow nesting) even when we populate it from raw
transcripts rather than from real OTel spans.

### 1.2 Claude Code native OTel export [verified — `code.claude.com/docs/en/monitoring-usage`]

Claude Code has **built-in OTel instrumentation** for three independent signals, each with its own switch:

- **Enable:** `CLAUDE_CODE_ENABLE_TELEMETRY=1`, then pick exporters: `OTEL_METRICS_EXPORTER`,
  `OTEL_LOGS_EXPORTER` (`otlp`/`prometheus`(metrics)/`console`/`none`). **Traces** are beta and require
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` + `OTEL_TRACES_EXPORTER`. Standard OTLP transport vars apply
  (`OTEL_EXPORTER_OTLP_ENDPOINT/PROTOCOL/HEADERS`, per-signal overrides, mTLS). Default export intervals:
  metrics 60 s, logs/traces 5 s.
- **Metrics:** `claude_code.session.count`, `lines_of_code.count`, `pull_request.count`, `commit.count`,
  `cost.usage` (USD), `token.usage`, `code_edit_tool.decision`, `active_time.total`. The **cost counter**
  carries rich attributes: `model`, `query_source` (`main`/`subagent`/`auxiliary`), `speed`, `effort`
  (`low`..`max`), `agent.name`, `skill.name`, `plugin.name`. Token usage breaks down by `type`
  (input/output/cacheRead/cacheCreation).
- **Standard attributes** on everything: `session.id`, `app.version`, `app.entrypoint`
  (`cli`/`sdk-cli`/`sdk-ts`/`sdk-py`/`claude-vscode`), `organization.id`, `user.account_uuid`,
  `user.account_id`, `user.id` (anon install id), `user.email`, `terminal.type`
  (`iTerm.app`/`vscode`/`cursor`/`tmux`). Events additionally carry `prompt.id` (correlates a prompt with
  all downstream events) and `workspace.host_paths`.
- **Events (logs):** `claude_code.user_prompt` (length; content only with `OTEL_LOG_USER_PROMPTS=1`),
  `claude_code.tool_result` (`tool_name`, `success`, `duration_ms`, `error`, `decision` accept/reject,
  `source`, and `tool_parameters` incl. Bash `bash_command`/`full_command`/`timeout`/`sandbox` when
  `OTEL_LOG_TOOL_DETAILS=1`), `claude_code.api_request` (`input_tokens`/`output_tokens`/`cache_read_tokens`,
  duration), `claude_code.api_error`, `tool_decision`. MCP calls produce structured events with server name,
  tool name, and args under `OTEL_LOG_TOOL_DETAILS=1`.
- **Traces (beta):** spans `claude_code.interaction` (one agent turn), `claude_code.llm_request`
  (model, latency, token counts), `claude_code.tool` (with children `claude_code.tool.blocked_on_user` and
  `claude_code.tool.execution`), `claude_code.hook`. Content opt-in: `OTEL_LOG_TOOL_CONTENT=1` (60 KB cap,
  requires tracing), `OTEL_LOG_RAW_API_BODIES=1` or `file:` (full Anthropic Messages API request/response
  JSON, including whole conversation history, thinking redacted).
- **Limitations [verified/inferred]:** push-only (you must run/own a collector); batched with bounded flush
  on exit, so spans/metrics can be **dropped** if the process is killed or collector is slow; content
  redacted by default; metrics deliberately omit high-cardinality attributes (no `prompt.id` on metrics);
  the Agent SDK emits the *same* data because it shells out to the same CLI; `console` exporter is unusable
  under the SDK (it collides with the SDK's stdio channel).

**Org vs individual access.** Org: set the env vars centrally (managed settings / Dockerfile / k8s) and
point at a shared collector → Datadog/Honeycomb/Grafana/ClickHouse. Individual: same vars pointed at a
**localhost collector** (e.g. `http://localhost:4318`) — this is exactly what `aarogyarijal/cc-analytics`
does (OTel → local FastAPI → SQLite). Both paths are first-class and documented.

### 1.3 Hooks-based capture [verified]

Claude Code hooks (`PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionStart/End`,
`UserPromptSubmit`, `PreCompact`, `Notification`) fire shell commands with event JSON on stdin, including
`transcript_path`. This is the mechanism `AgenticSec/ClaudeCodeUsageDashboard` uses: a **Stop hook**
parses the just-finished `~/.claude/projects/{hash}/{session_id}.jsonl` and POSTs tokens/skills/MCP/subagent
events to a server. Hooks give *event timing* and a guaranteed "session done" trigger without standing up a
collector, but you still design your own schema and you only get what you parse from the transcript.

### 1.4 Gateway / proxy approaches [verified]

- **LiteLLM proxy** (`docs.litellm.ai`): OpenAI-compatible proxy in front of 100+ providers. Emits a
  `StandardLoggingPayload` per call (`id`, `trace_id`, `call_type`, `response_cost`, `cost_breakdown`,
  `status`, `messages`, `response`, `usage_object`, `cache_key`, `cache_hit`, `api_base`, `model_id`,
  `x-litellm-attempted-retries`/`fallbacks`, `applied_guardrails`, `mcp_tool_call_metadata`, etc.).
  40+ callback sinks (Langfuse, OTel, Datadog, S3/GCS, Prometheus, PostHog, custom). A newer
  `LITELLM_OTEL_V2=true` emits one OTel trace per request following GenAI semconv with presets for
  Arize/Phoenix/Langfuse/Weave. Spend tracking lives in Postgres; **by default LiteLLM tags `User-Agent` as
  a cost tag, which already lets it attribute spend to "Claude Code", "Gemini CLI", etc.** Privacy kill-switch
  `turn_off_message_logging=True`. **This is the single richest live-telemetry option** but adds a Python
  service + Postgres + Redis.
- **OpenRouter:** returns per-request `usage.cost` in the response (good), but dashboard cost is otherwise
  aggregate and you cannot audit their pricing formula; handles failover/retries for you (opaque).
- **Cloudflare AI Gateway:** transparent edge logging + caching + latency metrics; **no routing, no
  failover, no budgets**, and **does not return per-request cost to the caller** (dashboard only).
- **Vercel AI Gateway / Portkey / Kong AI Gateway:** all expose OTel-based traces over their OpenAI-compatible
  endpoints (per OpenObserve's gateway integration docs), so any of them can feed an OTLP collector.

**Catch for Claude Code specifically [inferred]:** Claude Code authenticates to Anthropic (OAuth/subscription
or API key). Routing it through a gateway requires `ANTHROPIC_BASE_URL` (or Bedrock/Vertex envs) and an API
key, which most subscription users won't do. So a proxy is a great fit for **org/API-key deployments and the
Agent SDK**, but not for the typical individual Pro/Max user. Transcripts + native OTel cover that user.

### 1.5 Observability platforms (where data lands) [verified — VibeReference comparison + vendor docs]

| Platform | Model / data shape | Granularity | Push/Pull | Self-host | Deep access for an org | Deep access for an individual |
|---|---|---|---|---|---|---|
| **Langfuse** | Trace → nested observations (span/generation/event); scores, sessions, users, prompt mgmt, evals | Per-call + nested + session | Push (SDK/OTLP) | **Yes, MIT core** | Self-host + RBAC; OTLP ingest | Free tier 50K obs/mo or local Docker |
| **Helicone** | Proxy-first; request/response logs, cost, caching, sessions | Per-request | Push via proxy header or OTLP | **Yes, Apache-2** | Proxy in front of provider | Free 10K req/mo |
| **Arize Phoenix** | **OpenInference/OTel-native** spans; built for evals/RAG | Span tree | Push (OTLP) | **Yes, Apache-2** | Self-host collector | `pip install`, runs locally |
| **OpenLLMetry / Traceloop** | Pure OTel-GenAI instrumentation SDK → any OTLP backend | Span | Push (OTLP) | **Yes, OSS SDK** | Vendor-neutral | Local collector |
| **Braintrust** | Evals-first; logs + datasets + experiments | Per-call + eval | Push (SDK) | No (SaaS) | SaaS, eval-heavy teams | Trial |
| **Datadog LLM Obs** | Spans/traces in APM; clusters, quality checks | Span | Push (SDK/OTLP) | No (SaaS) | Enterprise APM correlation | n/a |
| **Honeycomb** | Wide events / OTel traces; high-cardinality query (BubbleUp) | Event/span | Push (OTLP) | No (SaaS) | Best-in-class trace querying | Free tier |

**Takeaway:** the OSS, self-host, OTLP-ingesting platforms (Langfuse, Phoenix, Helicone, Traceloop) are the
direct conceptual competition for "an observability platform you run yourself." Their advantage is mature
trace UIs + evals; their gap (for *our* niche) is they treat the agent as an opaque API client and have **no
concept of the Claude Code transcript** — subagent trees, skills/plugins, permission modes, hook events,
compaction, file-touch lineage. That is exactly the gap a transcript-golden-source tool fills.

---

## 2. Transcript-as-golden-source thesis

### 2.1 What the Claude Code JSONL reliably contains [observed — real `~/.claude/projects/*.jsonl`]

Per-line top-level fields seen across `user`/`assistant`/`progress`/`queue-operation` rows:
`type`, `uuid`, `parentUuid`, `sessionId`, `timestamp` (ISO 8601), `cwd`, `gitBranch`, `version`
(CC version), `userType`, `isSidechain`, `permissionMode`, `slug`, `promptId`, `requestId` (assistant),
`message`, `toolUseResult` (on user rows that carry tool output), `parentToolUseID`/`toolUseID` (progress),
`sourceToolAssistantUUID`.

Inside `assistant.message`: `id`, `role`, `model`, `stop_reason`, `stop_sequence`, `content[]` (blocks:
`text`, `thinking`, `tool_use`, ...), and **`usage`**: `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation` (with
`ephemeral_5m_input_tokens`/`ephemeral_1h_input_tokens`), `service_tier`, **`inference_geo`**.
`toolUseResult` is structured (e.g. `{file, type}` for a file read; tool-specific shapes elsewhere).

**A faithful per-conversation state can therefore be reconstructed [verified by what's present]:**

- **Identity/context:** session id, project (`cwd`/path hash), git branch, CC `version`, `app`/entry hints,
  `permissionMode` (e.g. `default`/`acceptEdits`/`plan`/`bypassPermissions`), timeline from `timestamp`s.
- **Models & cost:** every model used per turn; full token + ephemeral-cache breakdown; `service_tier`;
  cost via a pricing table (this repo already does this).
- **Tool sequences (ordered):** every `tool_use` block with name + input, paired to its `tool_result` /
  `toolUseResult` via `tool_use.id`. This is the raw material for an **event stream**, not just counts.
- **MCP tools:** distinguishable by the `mcp__server__tool` naming convention in `tool_use.name`.
- **Skills/plugins/slash commands:** Skill-tool invocations, `/command` slugs, and `slug` field.
- **CLIs/commands run:** Bash `tool_use.input.command` (full shell command + description).
- **Files touched:** Read/Edit/Write/MultiEdit/NotebookEdit tool inputs + `toolUseResult.file` give a
  file-lineage graph per session.
- **Subagent trees:** `isSidechain`/`parentUuid`/`parentToolUseID` + Task tool_use → reconstruct the
  agent/workflow nesting (this repo's `AgentAnalyzer` already does the tree).
- **Errors:** `is_error` on tool_result blocks; assistant `stop_reason`; refusals.
- **Techniques/patterns [inferred]:** plan mode usage, thinking-block presence/length, compaction events,
  todo usage, retries visible as repeated identical tool calls — all derivable but heuristic.

### 2.2 What is lossy or absent vs OTel/hook/proxy [verified/inferred]

| Signal | In transcript? | Where it lives instead | Does it matter? |
|---|---|---|---|
| **Per-request wall-clock latency** | **No** | OTel `api_request.duration_ms`, `claude_code.llm_request` span, proxy timing | **Yes** — "why is this agent slow" needs it |
| **Tool execution duration** | **No** (only timestamps between rows, which conflate model + tool + user-wait) | OTel `tool_result.duration_ms` | **Yes** for perf/cost-of-time analysis |
| **Streaming timing (TTFT/TPOT)** | No | OTel client metrics / proxy | Niche; mostly for model-perf tuning |
| **Retries / fallbacks** | Mostly no (a retried request may not appear) | OTel `api_error` events, LiteLLM `attempted-retries` | **Yes** for reliability analysis |
| **HTTP status / error bodies** | Partial (tool errors yes; API-level errors usually not) | OTel `api_error`, proxy | Medium |
| **Cache hit *rate* / cost saved** | **Derivable** (cache_read vs cache_creation tokens are present) | same, but transcript already has it | Already covered |
| **Request/response headers, rate-limit headers** | No | proxy / `OTEL_LOG_RAW_API_BODIES` | Low for most users |
| **Permission "blocked on user" wait time** | No | `claude_code.tool.blocked_on_user` span | Medium (UX/ergonomics insight) |
| **Lines of code / commits / PRs as first-class counters** | Derivable from edits/Bash, but messy | OTel `lines_of_code.count`, `commit.count`, `pull_request.count` | Medium — OTel is cleaner |
| **Cost (authoritative)** | No — only token counts; cost is *estimated* from a pricing table | OTel `cost.usage` (USD, vendor-computed), proxy `response_cost` | **Yes** if accuracy matters |

**Bottom line [inferred]:** The transcript is the **most complete record of *what the agent did*** (intent,
tool sequence, files, subagents, skills, content) and is the only source available retroactively and for
subscription users. It is **weakest on *time and reliability*** (latencies, retries, TTFT) and on
**authoritative cost**. Those gaps are precisely what native OTel and proxies fill. This is the core argument
for a **hybrid** design rather than picking one source.

---

## 3. Multi-harness reality

### 3.1 Where each harness stores its transcript [verified — claude-replay, agent-transcript skill, Cline/Cursor docs, ccusage]

| Harness | Location | Format | Notable |
|---|---|---|---|
| **Claude Code** | `~/.claude/projects/<path-hash>/<session-id>.jsonl` | JSONL, rich per-row metadata | The richest of the lot (see §2) |
| **Codex CLI (OpenAI)** | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`; index `~/.codex/history.jsonl` | **Event-based JSONL** (`session_meta`, `response_item`, `event_msg`) with timestamps | First row `session_meta` has `id`, `cwd`, `model_provider`, `cli_version`. Tools `exec_command`/`apply_patch`. Encrypted reasoning skipped |
| **Gemini CLI** | `~/.gemini/tmp/<projectHash>/chats/session-<id>.json` (+ `checkpoints/`) | Historically single JSON; **moving to append-only JSONL** (PR #15309, Dec 2025) | `sessionId` + `messages[]` of `user`/`gemini`; inline thoughts; tools `run_shell_command`/`read_file`/`edit_file`; hook `transcript_path` now `.jsonl` |
| **Cursor** | `~/.cursor/projects/<...>/agent-transcripts/<id>.jsonl` (flat or nested) + `~/.cursor/chats/<...>/store.db` + global `state.vscdb` | **Multiple stacks**: transcript JSONL **+ SQLite** (`store.db`, `composerData`/`bubbleId`); **no timestamps in JSONL** | Hardest to normalize: provenance spread across JSONL, SQLite, and checkpoint sidecars |
| **Cline** | `~/.cline/data/tasks/<taskId>/api_conversation_history.json` (also VS Code globalStorage `saoudrizwan.claude-dev/tasks/`); `ui_messages.json`; index `taskHistory.json` | JSON array in **Anthropic `MessageParam` format** | Anthropic-shaped content blocks (text/tool_use) — closest to Claude Code semantics. Known history-corruption/auto-delete issues |
| **GitHub Copilot CLI** | varies; often requires in-app export | `.jsonl`/`.json`/`.md` | Least standardized; `ccusage copilot` reads it for usage |
| **OpenCode / Amp / Droid / Goose / Kilo / Qwen / etc.** | various | mostly JSONL | `ccusage` already auto-detects ~15 sources for *usage*; `claude-replay` renders 5 for *display* |

### 3.2 A common normalized event/state model [recommendation, OTel-aligned]

Define an internal schema that is **OTel-GenAI-shaped but transcript-populated**. Two grains:

**Event grain (append-only):**

```
event {
  event_id, harness, session_id, project, ts (nullable for Cursor), parent_event_id,
  kind: prompt | model_request | tool_call | tool_result | agent_invoke | hook | error | system,
  role, model, provider,
  tokens {input, output, cache_read, cache_creation_5m, cache_creation_1h}, service_tier,
  cost_usd (estimated | authoritative), latency_ms (nullable),
  tool {name, namespace(mcp/skill/builtin), args_ref, result_ref, is_error},
  files_touched[], git_branch, permission_mode, agent_name, skill_name, plugin_name,
  content_ref  // FTS-indexed blob, capped
}
```

**Session/state grain (rollup):** the per-conversation "state" the owner wants — derived by folding events
(models, total cost, tool histogram, MCP/skills/plugins, file set, subagent tree, error count, techniques).

**Mapping is mechanical [verified by claude-replay doing exactly this]:** `claude-replay` already maps
Codex `exec_command`/`apply_patch` → `Bash`/`Edit`/`Write` and Gemini `run_shell_command`/`read_file` →
`Bash`/`Read`. SFTizer normalizes Claude/Gemini/Cursor/Cline into one OpenAI-style messages format.
So the normalization is proven feasible; the work is in **bespoke parsers per harness feeding one schema**.

### 3.3 Where OTel fits vs bespoke parsers [inferred]

- **Bespoke parsers** are unavoidable for the **transcript golden source** — each harness's on-disk format
  is different and OTel cannot retro-emit history. This is where the unique value is.
- **OTel** is the right **enrichment + live** lane and the right **internal vocabulary**. Claude Code, the
  Agent SDK, and LiteLLM all already speak OTel-GenAI; Phoenix/Traceloop are OTel-native. Adopting
  `gen_ai.*` naming internally means an OTLP ingest endpoint is a thin adapter, and we stay interoperable.
- **Net:** *parse transcripts into an OTel-shaped model; accept OTel where available to fill the time/cost
  gaps.* Don't try to make everything an OTel span, and don't invent a vocabulary OTel already standardized.

---

## 4. Plumbing options & architecture

### Option A — Stay transcript-parsing only (status quo, deepened)
- **Data model:** add the **event grain** (§3.2) below today's session grain; SQLite stays.
- **Storage:** SQLite + FTS5 is fine to ~low-millions of events on one box. Add a `messages`/`events` table
  and `tool_events` table; keep FTS5 for content.
- **Real-time:** existing FileWatcher; add Stop-hook ingestion for instant "session complete" without polling.
- **Multi-harness:** add parsers for Codex/Gemini/Cline/Cursor into the shared event schema.
- **Query patterns:** "show the tool sequence for session X", "which sessions ran `git push`",
  "files most edited", "subagent fan-out", FTS over tool args/results.
- **Pros:** zero new infra; works for subscription users and retroactively; privacy-preserving (all local).
- **Cons:** no latency/retry/authoritative cost; analytics over very large histories will strain SQLite.
- **Would NOT do:** don't bolt on time-series rollups in SQLite by hand if volumes grow — that's DuckDB's job.

### Option B — Add an OTel collector / ingest path
- Stand up an **OTLP receiver** (`/v1/metrics`, `/v1/logs`, optionally `/v1/traces`) — exactly the
  `cc-analytics` pattern (OTel → FastAPI/Express → SQLite, SSE live feed). Users set
  `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*_ENDPOINT=http://localhost:<port>`.
- **Adds:** authoritative cost (`cost.usage`), per-request/tool **latency**, `lines_of_code`/`commit`/`PR`
  counters, accept/reject decisions, `api_error`, and the rich cost attributes
  (`query_source`/`speed`/`effort`/`agent.name`/`skill.name`/`plugin.name`).
- **Pros:** fills every §2.2 gap for Claude Code; standard, vendor-neutral; same endpoint later accepts
  LiteLLM/Phoenix/Gemini OTel.
- **Cons:** push-only and **forward-only** (no history); requires user config; lossy on hard kills; metrics
  are aggregated (no per-message join without `prompt.id`/`session.id` correlation, which events do carry).
- **Storage note:** OTel metrics are delta/cumulative time series — they aggregate well in DuckDB/ClickHouse;
  SQLite works for a single user.

### Option C — Add a proxy (LiteLLM) for live telemetry
- Run LiteLLM proxy; point harnesses' `*_BASE_URL` at it; consume `StandardLoggingPayload` (cost,
  cache_hit, retries, latency, MCP tool metadata) via a custom callback into our store, or OTLP v2.
- **Pros:** richest *live* request-level truth incl. retries/cache/headers and authoritative cost;
  inherently multi-harness (anything OpenAI/Anthropic-compatible) and already User-Agent-tags Claude Code,
  Gemini CLI, etc.
- **Cons:** heaviest infra (Python + Postgres + Redis); **does not work for Claude Code subscription auth**
  without an API key; intercepting traffic is a bigger ask than reading files. Best for org/API-key/SDK fleets.
- **Would NOT do:** don't make the proxy a *requirement* for the product — it's an optional enrichment lane.

### Option D — Hybrid: transcript golden-source + OTel enrichment (RECOMMENDED)
- **Golden source = transcripts** (retroactive, complete-on-intent, works for everyone, all-local).
- **Optional OTel lane** (Option B) joined on `session.id` to attach latency, authoritative cost, decisions,
  and code/commit/PR counters to the transcript-derived events.
- **Optional proxy lane** (Option C) for org/API-key/SDK users who want request-level reliability data.
- **Optional Stop-hook** trigger for instant ingest.
- **Storage:** keep **SQLite + FTS5** as the default single-user store (it's the project's whole appeal:
  zero-infra, local, fast). Add **DuckDB** as an *analytics* engine for heavy time-bucketed/columnar queries
  over events (DuckDB can query the same data / Parquet exports without a server). Reserve **ClickHouse**
  (what Langfuse/Helicone use under the hood) or **Postgres+Timescale** only for a future multi-user/team
  hosted edition — do **not** adopt it for the local tool.
- **Query patterns unlocked:** join transcript tool sequence ⨝ OTel tool latency ⨝ authoritative cost →
  "most expensive tool chains", "slowest subagents", "cache savings per project", "accept-rate by language",
  plus the existing FTS over content.

### Recommended phased roadmap

1. **Phase 1 — Event grain over transcripts (Option A).** Land the per-message/role/tool event schema
   (the work already in flight), add Codex + Gemini + Cline parsers into the shared schema (Cursor later —
   it's the messy one). Keep SQLite+FTS5. *This alone makes it a multi-harness transcript observability tool.*
2. **Phase 2 — Local OTel ingest (Option B).** Add an optional OTLP endpoint; join on `session.id` for
   latency + authoritative cost + decisions + LoC/commit/PR. Document the env vars. This closes the §2.2 gaps
   for Claude Code without forcing anyone to use it.
3. **Phase 3 — Analytics engine + dashboards.** Introduce DuckDB for columnar analytics over the event store;
   build the dashboards (tool latency, cost-by-model/project, cache efficiency, error rates, subagent cost).
4. **Phase 4 (optional) — Proxy + team edition.** LiteLLM enrichment for API-key/org users; if a hosted
   multi-user edition emerges, move the analytics tier to ClickHouse/Timescale then, not before.

### Explicitly what NOT to do
- Don't replace transcripts with OTel as the source of record — OTel is forward-only and content-redacted.
- Don't require a proxy or a collector for the core product — they're optional lanes; the local-only,
  zero-infra story is the differentiator.
- Don't migrate the single-user store off SQLite/FTS5 prematurely; reach for DuckDB only for analytics, and
  ClickHouse/Postgres only when/if you build a hosted team product.
- Don't invent a telemetry vocabulary — mirror OTel `gen_ai.*` / Claude Code attribute names so ingest is a thin adapter.
- Don't try to perfectly normalize Cursor first; its multi-stack SQLite+JSONL provenance is the highest-effort, lowest-uniformity target.

---

## 5. Prior art / competitive

**Transcript-reading, local, Claude-Code-focused (our neighborhood):**
- **`ccusage`** (ryoppippi, ~10K★) — CLI; reads local data for **~15 harnesses** (Claude, Codex, Gemini,
  Copilot, OpenCode, Amp, Droid, Goose, Kilo, Qwen, Kimi, Codebuff, Hermes, pi, OpenClaw). Daily/weekly/
  monthly/session + 5-hour billing blocks, per-model breakdown, offline pricing. **The reference for cost +
  multi-source detection.** No search, no conversation viewer, no observability.
- **`ccboard`** (FlorianBruniaux, Rust) — TUI + Web single binary; 12 tabs incl. config/hooks/agents/MCP,
  FTS5 search, conversation viewer, subagent tree, live process tracking, budget/forecast, security audit,
  third-party session badges (Cursor/Codex/OpenCode). **Closest functional competitor** to the owner's vision,
  but Rust/TUI-first and not OTel/proxy-aware.
- **`cc-lens`/`cx-lens`** (Arindam200 et al.) — local React dashboard reading `~/.claude` incl. history,
  todos, plans, memory, settings; session replay, tool/MCP/agent analytics, activity calendar.
- **`claudelytics`** (Rust TUI, stale ~6 mo), **`agtrace`** (Rust TUI, MCP-server mode, multi-provider).
- **`ccusage-web` / `ccusage-ui` / `sowonlabs`** — web front-ends over ccusage (cost-only).
- **`claude-replay`** (ben-alkov) and **SFTizer** (thad0ctor) — multi-harness transcript **parsing/rendering/
  normalization**; great references for the parser layer and tool-name mapping.

**OTel-based, local:**
- **`aarogyarijal/cc-analytics`** — "OTel → SQLite → React", local OTLP receiver, SSE live feed, tool
  latency/treemap, decisions, sessions, even energy/CO2 estimates. **The reference implementation for our
  Phase 2.**
- **`Nitjsefnie/ccusage-dashboard` (ccudash)** — FastAPI + **Postgres**, R2/local ingest, burn rate, cache
  TTL split, context growth, **reply latency**, tool error rate. Shows the analytics panels worth building and
  that Postgres is the path for a hosted/multi-user variant.
- **`AgenticSec/ClaudeCodeUsageDashboard`** — **Stop-hook**-based team dashboard (tokens, skills, MCP,
  subagents) → SQLite + React. Reference for the hook-ingest pattern and team rollups.

**SaaS / general LLM-obs:** Langfuse, Helicone, Phoenix, Traceloop, Braintrust, Datadog LLM Obs, Honeycomb
(see §1.5). These do *not* understand coding-agent transcripts (subagents, skills, permission modes,
compaction, file lineage) — that's the moat.

**Gaps we could uniquely fill:**
1. **Search + observability in one** — none of the above pairs FTS5 full-text search across content/tool
   args/results *with* observability metrics. This repo already has the search half.
2. **Hybrid golden-source + OTel** — competitors are either transcript-only (ccusage/ccboard/cc-lens) or
   OTel-only (cc-analytics/ccudash). Joining them on `session.id` is unclaimed.
3. **True multi-harness *observability state*** (not just usage) — ccusage does multi-harness *cost*;
   nobody does a unified normalized *event/tool/file/subagent state* across harnesses.
4. **Technique/pattern mining** — surfacing workflow patterns (plan mode, subagent fan-out, compaction
   behavior, retry loops, expensive tool chains) is underserved.

---

## 6. Recommendation (decision)

**Adopt Option D (hybrid).** Keep **raw transcripts as the golden source** and the **SQLite + FTS5**,
local-first, zero-infra core — that is the product's identity and its moat against SaaS LLM-obs tools.
Layer an **OTel-shaped event model** (mirroring `gen_ai.*` / Claude Code attributes) beneath today's
session aggregates, populated by **per-harness transcript parsers** (Claude Code → Codex → Gemini → Cline →
Cursor, in that effort order). Add an **optional local OTLP ingest** lane to recover the signals transcripts
can't give (per-request/tool latency, retries, authoritative USD cost, LoC/commit/PR, accept-reject
decisions), joined on `session.id`. Treat **LiteLLM/proxy** as an *optional* enrichment for org/API-key/SDK
fleets only — never a requirement. Use **DuckDB** for heavy analytics, and defer **ClickHouse/Postgres** to a
possible future hosted team edition.

---

## References

Claude Code / Anthropic (primary):
- Monitoring (OTel metrics/events/traces, env vars, attributes): https://code.claude.com/docs/en/monitoring-usage
- Agent SDK Observability with OpenTelemetry (span names, signals): https://code.claude.com/docs/en/agent-sdk/observability

OpenTelemetry GenAI semantic conventions (primary):
- Overview: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Spans: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
- Metrics: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/
- Events: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/
- Agent/framework spans: https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-agent-spans.md
- LLM call examples: https://opentelemetry.io/docs/specs/semconv/gen-ai/non-normative/examples-llm-calls

Gateways / proxies (primary):
- LiteLLM logging: https://docs.litellm.ai/docs/proxy/logging
- LiteLLM OTel integration: https://docs.litellm.ai/docs/observability/opentelemetry_integration
- LiteLLM StandardLoggingPayload: https://docs.litellm.ai/docs/proxy/logging_spec
- LiteLLM spend/cost tracking (User-Agent tagging): https://docs.litellm.ai/docs/proxy/cost_tracking
- AI gateway observability (OpenObserve): https://openobserve.ai/docs/integration/ai/gateways/
- LLM gateway comparison 2026 (OpenRouter/Cloudflare/LiteLLM): https://relayplane.com/blog/llm-gateway-comparison-2026

Observability platforms:
- LLM observability providers comparison: https://www.vibereference.com/ai-development/llm-observability-providers
- Langfuse data model: https://langfuse.com/docs/observability/data-model
- Arize Phoenix tracing: https://docs.arize.com/phoenix/tracing/llm-traces

Multi-harness transcript formats:
- claude-replay (CC/Cursor/Codex/Gemini/OpenCode locations + formats): https://github.com/ben-alkov/claude-replay
- agent-transcript skill (CC/Codex/Gemini/Copilot/Cursor/Kiro locations): https://github.com/siegerts/agent-transcript/blob/main/skills/agent-transcript/SKILL.md
- Cline prompt storage (api_conversation_history.json, MessageParam format): https://docs.cline.bot/enterprise-solutions/monitoring/prompt-storage
- Cline storage-location issue (globalStorage tasks): https://github.com/cline/cline/issues/6564
- Cursor local storage deep dive (JSONL + state.vscdb): https://vibe-replay.com/blog/cursor-local-storage/
- Gemini CLI JSONL session recording PR: https://github.com/google-gemini/gemini-cli/pull/15309
- SFTizer (multi-source normalization): https://github.com/thad0ctor/SFTizer/

Prior-art Claude Code analytics/observability:
- ccusage (multi-harness usage CLI): https://github.com/ryoppippi/ccusage
- ccboard (Rust TUI+Web, FTS5, config/hooks/agents/MCP): https://github.com/FlorianBruniaux/ccboard
- cc-lens / cx-lens (local React dashboard): https://github.com/shivjsdev/cx-lens
- cc-analytics (OTel → SQLite → React): https://github.com/aarogyarijal/cc-analytics
- ccusage-dashboard / ccudash (FastAPI + Postgres, latency/cache/context panels): https://github.com/Nitjsefnie/ccusage-dashboard
- AgenticSec ClaudeCodeUsageDashboard (Stop-hook team dashboard): https://github.com/AgenticSec/ClaudeCodeUsageDashboard
- ccusage-web (Next.js over ccusage): https://github.com/hamzaahmedkhan/ccusage-web

Local primary inspection: `~/.claude/projects/*.jsonl` field shapes verified directly on the author's machine
(2026-06-03); this repo's `src/analytics/core/*.js` and `src/analytics/data/DatabaseManager.js`.
