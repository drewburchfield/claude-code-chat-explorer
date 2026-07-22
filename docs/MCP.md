# Claude Chats Search — MCP server

Exposes your indexed Claude Code conversation history to MCP clients (e.g. Claude
Code, Claude Desktop) so an agent can search its own past conversations far faster
than grepping raw JSONL.

It reads the **same SQLite index** the web app builds, **read-only** (WAL-safe), and
serves search through the same `SearchService` the REST API uses — so the MCP surface
never drifts from the web UI.

## Tools

| Tool | Purpose |
|---|---|
| `search_conversations` | Full-text search with FTS operators (`AND`/`OR`/`NOT`, `"phrase"`, `prefix*`) + filters (`project`, `model`, `includeSubagents`, `subagentsOnly`). Returns ranked hits with snippets **and a `resource_link` per hit** so transcripts are fetched only on demand. |
| `search_within_conversation` | Find matching lines inside one conversation. |
| `list_facets` | Available `projects`, `models`, `tools`, and the conversation `dateRange` for building filters. |

All tools declare an `outputSchema` and return `structuredContent`. Conversations are
exposed as resources at `claude-chat://conversation/{id}` (raw JSONL transcript).

Malformed queries return a tool execution error (`isError: true`) with an actionable
message so the model can self-correct.

## Running

```bash
# From the repo:
npm run mcp
# or, if installed/linked:
claude-chats-mcp
```

The server logs to **stderr** (stdout is the JSON-RPC channel). It opens the database at
`$CLAUDE_DB_PATH`, else `$CLAUDE_HOME/data/conversations.db`, else
`~/.claude/data/conversations.db`. The file must already exist (build it by running the
web app once, which indexes your history).

## Add to Claude Code

`.mcp.json` (or via `claude mcp add`):

```json
{
  "mcpServers": {
    "claude-chats-search": {
      "command": "node",
      "args": ["/absolute/path/to/claude-code-chat-explorer/src/mcp/server.js"],
      "env": {
        "CLAUDE_DB_PATH": "/absolute/path/to/conversations.db"
      }
    }
  }
}
```

If you run the web app in Docker, point `CLAUDE_DB_PATH` at the host-mounted DB file
(the `chat-explorer-*-db` volume mount, e.g. `~/.claude/data/conversations.db`).

### Transcript access

The `claude-chat://conversation/{id}` resource streams the raw JSONL transcript from the
path recorded at index time (under `~/.claude/projects/...`). The MCP server therefore
needs read access to those files at their **original paths** — running it on the host is
simplest. If you run it in a container, mount `~/.claude` at the same absolute path the
index used (as the dev compose does). Without that, `search_conversations` still works
(metadata + snippets come from the DB), but reading a conversation resource returns a
clear "Transcript file unavailable" error.

Transcript reads are restricted to the configured root (`<CLAUDE_HOME>/projects` by
default): the server refuses to read a file whose indexed path resolves outside that
root, so a poisoned or stale index row can't be used to read arbitrary files.

### Treat retrieved history as untrusted data (prompt injection)

Search snippets and transcript resources return the **raw text of past conversations**,
which includes tool output — web pages Claude fetched, files it read, command output.
That content can contain text crafted to look like instructions ("ignore your previous
instructions and…"). When an agent queries history through this MCP server, that text
enters its context. Treat everything returned by `search_conversations` and the
`claude-chat://conversation/{id}` resource as **data to reason about, not instructions to
follow**. This is inherent to searching your own history and is not something the server
can strip for you — a hostile page captured in an old transcript is a second-order
prompt-injection vector for any future agent that reads it back.
