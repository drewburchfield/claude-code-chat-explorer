#!/usr/bin/env node
/**
 * MCP server exposing Claude Code conversation search to MCP clients.
 *
 * Reads the same SQLite index the web app builds (read-only, WAL-safe) and
 * serves search through the shared SearchService — so the MCP surface cannot
 * drift from the REST/UI surfaces. Conversations are exposed as resources;
 * search returns structured output plus resource links so clients fetch full
 * transcripts only on demand.
 *
 * Logs go to stderr because stdout is the JSON-RPC channel.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { z } = require('zod');
const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const DatabaseManager = require('../analytics/data/DatabaseManager');
const SearchService = require('../analytics/search/SearchService');

const CONVERSATION_URI = (id) => `claude-chat://conversation/${encodeURIComponent(id)}`;

function defaultDbPath() {
  return (
    process.env.CLAUDE_DB_PATH ||
    path.join(process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude'), 'data', 'conversations.db')
  );
}

/** Shape a SearchService result row into the compact MCP output object. */
function toHit(r) {
  return {
    conversationId: r.id,
    project: r.project || null,
    isSubagent: !!r.isSubagent,
    model: r.modelInfo?.primaryModel || null,
    lastModified: r.lastModified instanceof Date ? r.lastModified.toISOString() : (r.lastModified ?? null),
    snippet: r.snippet || null,
    relevance: r.relevance ?? null,
    uri: CONVERSATION_URI(r.id),
  };
}

/** A tool-execution error result (isError:true) so the model can self-correct. */
function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Build the MCP server around an already-initialized SearchService + db.
 * Exported for in-process testing via a linked transport.
 * @param {Object} deps - { search: SearchService, db: DatabaseManager }
 * @returns {McpServer}
 */
function buildServer({ search, db, transcriptRoot = null }) {
  const server = new McpServer({ name: 'claude-chats-search', version: '1.0.0' });

  // Transcript reads (resource + within-conversation) must stay under this
  // root, so a poisoned/stale index row can't be used to read arbitrary files
  // via a conversationId. Defaults to <CLAUDE_HOME>/projects.
  const allowedRoot = path.resolve(
    transcriptRoot ||
    path.join(process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude'), 'projects')
  );
  // Resolve the root through symlinks once, so comparisons happen in real-path
  // space. If the root itself doesn't exist yet, fall back to the lexical path.
  let realAllowedRoot = allowedRoot;
  try {
    realAllowedRoot = fs.realpathSync(allowedRoot);
  } catch {
    /* root not present yet; lexical comparison is the best we can do */
  }

  const isUnderRoot = (fp) => {
    if (!fp) return false;

    // path.resolve only normalizes lexically: it collapses ".." textually and
    // never touches the filesystem, so a symlink sitting INSIDE the transcript
    // root that points somewhere else entirely still looks like it is under the
    // root. Resolve the real path so the containment check can't be defeated by
    // planting a link in ~/.claude/projects.
    let resolved;
    try {
      resolved = fs.realpathSync(path.resolve(fp));
    } catch {
      // Missing file: fall back to the lexical check. The caller still has to
      // read it, which will fail on its own, and this keeps "file was deleted"
      // reporting as a clean not-found rather than a permission-looking error.
      resolved = path.resolve(fp);
      return resolved === allowedRoot || resolved.startsWith(allowedRoot + path.sep);
    }
    return resolved === realAllowedRoot || resolved.startsWith(realAllowedRoot + path.sep);
  };

  // ---- Tool: search_conversations -----------------------------------------
  server.registerTool(
    'search_conversations',
    {
      title: 'Search conversations',
      description:
        'Full-text search across indexed Claude Code conversations. Supports FTS operators ' +
        '(AND/OR/NOT, "exact phrase", prefix*). Returns ranked hits with snippets and a ' +
        'resource link per hit (claude-chat://conversation/{id}) to fetch the full transcript.',
      inputSchema: {
        query: z.string().describe('Search text; FTS operators supported'),
        project: z.string().optional().describe('Exact project name filter'),
        model: z.string().optional().describe('Exact primary model filter'),
        role: z.enum(['user', 'assistant', 'system', 'tool']).optional().describe('Match only within messages of this role'),
        tool: z.string().optional().describe('Match only within a specific tool\'s calls (role=tool)'),
        includeSubagents: z.boolean().optional().describe('Include subagent conversations (default true here)'),
        subagentsOnly: z.boolean().optional().describe('Restrict to subagent conversations'),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      outputSchema: {
        total: z.number(),
        degraded: z.boolean(),
        results: z.array(
          z.object({
            conversationId: z.string(),
            project: z.string().nullable(),
            isSubagent: z.boolean(),
            model: z.string().nullable(),
            lastModified: z.string().nullable(),
            snippet: z.string().nullable(),
            relevance: z.number().nullable(),
            uri: z.string(),
          })
        ),
      },
    },
    async (args) => {
      try {
        const res = search.search({
          query: args.query,
          project: args.project ?? null,
          model: args.model ?? null,
          role: args.role ?? null,
          tool: args.tool ?? null,
          includeSubagents: args.includeSubagents !== false, // default true for agent use
          subagentsOnly: args.subagentsOnly === true,
          limit: args.limit ?? 25,
          offset: args.offset ?? 0,
        });
        const hits = res.results.map(toHit);
        const structuredContent = { total: res.total, degraded: !!res.degraded, results: hits };
        return {
          structuredContent,
          content: [
            { type: 'text', text: JSON.stringify(structuredContent) },
            // Message-anchored resource links so the client can fetch transcripts on demand.
            ...hits.map((h) => ({
              type: 'resource_link',
              uri: h.uri,
              name: `${h.project || 'conversation'} (${h.conversationId})`,
              // Matches the resource handler's mimeType: transcripts are raw
              // newline-delimited JSON, not a single JSON document.
              mimeType: 'application/x-ndjson',
              description: h.snippet || undefined,
            })),
          ],
        };
      } catch (err) {
        return toolError(`Search failed (check query syntax): ${err.message}`);
      }
    }
  );

  // ---- Tool: list_facets ----------------------------------------------------
  server.registerTool(
    'list_facets',
    {
      title: 'List search facets',
      description: 'Available filter values: projects, models, tools, and the conversation date range.',
      inputSchema: {},
      outputSchema: {
        projects: z.array(z.string()),
        models: z.array(z.string()),
        tools: z.array(z.string()),
        roles: z.array(z.string()),
        dateRange: z.object({ min: z.number().nullable(), max: z.number().nullable() }),
      },
    },
    async () => {
      try {
        const facets = search.facets();
        return { structuredContent: facets, content: [{ type: 'text', text: JSON.stringify(facets) }] };
      } catch (err) {
        return toolError(`Failed to list facets: ${err.message}`);
      }
    }
  );

  // ---- Tool: search_within_conversation ------------------------------------
  server.registerTool(
    'search_within_conversation',
    {
      title: 'Search within a conversation',
      description: 'Find lines matching a query inside one conversation, with the matching text.',
      inputSchema: {
        conversationId: z.string(),
        query: z.string(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      outputSchema: {
        conversationId: z.string(),
        matches: z.array(z.object({ line: z.number(), text: z.string() })),
      },
    },
    async (args) => {
      try {
        const conv = db.getConversation(args.conversationId);
        if (!conv) return toolError(`Conversation not found: ${args.conversationId}`);
        if (!isUnderRoot(conv.filePath)) {
          return toolError(`Refusing to read a transcript outside the configured root for ${args.conversationId}.`);
        }
        if (!fs.existsSync(conv.filePath)) {
          // Mirror the resource handler: distinguish "file unreadable" from
          // "no matches" so a missing transcript isn't reported as 0 matches.
          return toolError(
            `Transcript file unavailable for ${args.conversationId} (path: ${conv.filePath || 'none'}). ` +
            `Ensure the MCP server can read the conversation JSONL files at their indexed paths.`
          );
        }
        const matches = searchWithinFile(conv.filePath, args.query, args.limit ?? 50);
        const structuredContent = { conversationId: args.conversationId, matches };
        return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
      } catch (err) {
        return toolError(`Within-conversation search failed: ${err.message}`);
      }
    }
  );

  // ---- Resource: a conversation transcript ---------------------------------
  server.registerResource(
    'conversation',
    new ResourceTemplate('claude-chat://conversation/{id}', { list: undefined }),
    { title: 'Conversation transcript', description: 'Raw JSONL transcript of a conversation' },
    async (uri, variables) => {
      const id = decodeURIComponent(variables.id);
      const conv = db.getConversation(id);
      if (!conv) {
        throw new Error(`Conversation not found: ${id}`);
      }
      if (!isUnderRoot(conv.filePath)) {
        throw new Error(`Refusing to read a transcript outside the configured root for ${id}.`);
      }
      if (!fs.existsSync(conv.filePath)) {
        // The conversation is indexed but its transcript file isn't readable
        // from here. Usually means the server can't see ~/.claude/projects
        // (e.g. running in a container without it mounted at the indexed path).
        throw new Error(
          `Transcript file unavailable for ${id} (path: ${conv.filePath || 'none'}). ` +
          `Ensure the MCP server can read the conversation JSONL files at their indexed paths.`
        );
      }
      const text = fs.readFileSync(conv.filePath, 'utf8');
      return { contents: [{ uri: uri.href, mimeType: 'application/x-ndjson', text }] };
    }
  );

  return server;
}

/** Scan a JSONL file for lines whose extracted text contains the query. */
function searchWithinFile(filePath, query, limit) {
  const needle = query.toLowerCase();
  const matches = [];
  if (!filePath || !fs.existsSync(filePath)) return matches;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (let i = 0; i < lines.length && matches.length < limit; i++) {
    const line = lines[i];
    if (line && line.toLowerCase().includes(needle)) {
      matches.push({ line: i + 1, text: line.length > 500 ? line.slice(0, 500) + '…' : line });
    }
  }
  return matches;
}

/**
 * Create a fully wired server from a db path (opens read-only).
 * @returns {Promise<{server: McpServer, db: DatabaseManager}>}
 */
async function createServerFromPath(dbPath) {
  const db = new DatabaseManager(dbPath, { readonly: true });
  await db.initialize();
  const search = new SearchService(db);
  const server = buildServer({ search, db });
  return { server, db };
}

async function main() {
  const dbPath = defaultDbPath();
  // eslint-disable-next-line no-console
  console.error(`[claude-chats-mcp] opening ${dbPath} (read-only)`);
  const { server } = await createServerFromPath(dbPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[claude-chats-mcp] ready on stdio');
}

module.exports = { buildServer, createServerFromPath, defaultDbPath, searchWithinFile };

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[claude-chats-mcp] fatal:', err);
    process.exit(1);
  });
}
