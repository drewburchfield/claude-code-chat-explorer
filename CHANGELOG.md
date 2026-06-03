# Changelog

## 0.9.0

Re-baselined below 1.0 to reflect pre-1.0 maturity. Search, multi-surface exposure, and an MCP server.

### Search
- FTS now indexes message text, thinking blocks, tool inputs/results, and system/queue/attachment content; the per-message (2K) and per-conversation (100K) truncation caps were removed (a 256KB per-block safety ceiling remains). Search matches what's on disk rather than a truncated projection.
- Query operators: `AND` / `OR` / `NOT`, `"exact phrase"`, `prefix*`.
- Filters: project, model, date range, and subagents; `GET /api/facets` returns facet values.
- Per-message role/tool granularity: restrict matches to a message role (user / assistant / system / tool) or a specific tool.
- A single `SearchService` query path is shared by the web UI, REST API, and MCP server.

### MCP server
- New stdio MCP server (`npm run mcp` / `claude-chats-mcp` bin) exposing `search_conversations`, `search_within_conversation`, and `list_facets` with structured output, plus conversations as resources (`claude-chat://conversation/{id}`). See `docs/MCP.md` and `.mcp.json.example`.

### Indexing
- Non-blocking background re-index: the server starts serving immediately and existing results stay searchable while the new index builds. An index-format change triggers a one-time re-index on upgrade.

### Packaging / security
- `engines.node` set to `>=20 <26` (the range `better-sqlite3` supports; Node 18 and 26+ fail to load the native binding).
- Resolved moderate npm advisories (qs / express / ws) via `npm audit fix`.
- npm installs in CI and the Docker image build are checked against Aikido safe-chain.

### Review hardening (post-review, same release)
- Degraded-search signal now actually reaches the REST response (it was read off the wrong object and always came back `false`); `/api/search` also reports `indexState`.
- FTS-failure fallbacks no longer mislead: `searchConversations` returns empty+degraded instead of the entire corpus, and role/tool search returns empty+degraded instead of cross-role matches that ignore the filter.
- MCP `search_within_conversation` errors (instead of returning empty) when a transcript file is unreadable.
- MCP transcript reads are restricted to the configured root (`<CLAUDE_HOME>/projects`): a poisoned/stale index row can't be used to read files outside it.

### Notes
- The per-message index increases on-disk size; plan for a few GB on large histories. Consolidation to reclaim this is tracked for a later release.
