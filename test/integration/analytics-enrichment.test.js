/**
 * Integration tests for the v5 parse-time enrichment: tool taxonomy +
 * error correlation, file-change extraction, src_line provenance, and the
 * /api/analytics REST surface over them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const request = require('supertest');
const { ChatsMobile } = require('../../src/chats-mobile.js');

describe('v5 enrichment pipeline', () => {
  let tempHome, app;

  beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-explorer-enrich-'));
    const claudeDir = path.join(tempHome, '.claude');
    const proj = path.join(claudeDir, 'projects', 'alpha');
    await fs.ensureDir(proj);

    // A session with: a Bash call that errors, a Bash call that succeeds,
    // an MCP call, and an Edit that changes a file. Results correlate by
    // tool_use_id, deliberately out of order relative to the calls.
    const ts = (s) => new Date(Date.UTC(2026, 0, 1, 12, 0, s)).toISOString();
    const lines = [
      { type: 'user', timestamp: ts(0), message: { role: 'user', content: 'please fix the build' }, cwd: '/work/demo' },
      { type: 'assistant', timestamp: ts(5), message: { role: 'assistant', model: 'claude-opus-4', content: [
        { type: 'tool_use', id: 'toolu_ok', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', id: 'toolu_bad', name: 'Bash', input: { command: 'npm run build' } },
        { type: 'tool_use', id: 'toolu_mcp', name: 'mcp__exa__web_search_exa', input: { query: 'error ENOENT' } },
        { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: {
          file_path: '/work/demo/src/index.js', old_string: 'a\nb\nc', new_string: 'a\nc' } },
      ] } },
      // Results out of order: the error joins by id, never by position.
      { type: 'user', timestamp: ts(10), message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_bad', content: 'build exploded', is_error: true },
        { type: 'tool_result', tool_use_id: 'toolu_ok', content: 'all green' },
        { type: 'tool_result', tool_use_id: 'toolu_mcp', content: 'results...' },
        { type: 'tool_result', tool_use_id: 'toolu_edit', content: 'ok' },
      ] } },
      { type: 'assistant', timestamp: ts(15), message: { role: 'assistant', model: 'claude-opus-4', content: 'fixed the build' } },
    ];
    await fs.writeFile(path.join(proj, 'enriched.jsonl'),
      lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    process.env.CLAUDE_DB_PATH = path.join(tempHome, 'conversations.db');
    app = new ChatsMobile({ port: 0, claudeDir, verbose: false });
    await app.initialize();
    await app.startServer();
    if (!app.databaseBackend?.isInitialized) throw new Error('DB backend did not initialise');
  }, 30000);

  afterAll(async () => {
    try { if (app) await app.stop(); }
    finally { delete process.env.CLAUDE_DB_PATH; if (tempHome) await fs.remove(tempHome).catch(() => {}); }
  }, 30000);

  it('GET /api/analytics/tools reports kinds, MCP servers, and correlated errors', async () => {
    const res = await request(app.app).get('/api/analytics/tools').expect(200);

    const bash = res.body.tools.find(t => t.tool_name === 'Bash');
    expect(bash).toBeTruthy();
    expect(bash.tool_kind).toBe('shell');
    expect(bash.total_calls).toBe(2);
    // Exactly one Bash call errored, joined via tool_use_id despite the
    // results arriving out of order.
    expect(bash.total_errors).toBe(1);

    const mcp = res.body.tools.find(t => t.tool_name === 'mcp__exa__web_search_exa');
    expect(mcp.tool_kind).toBe('mcp');
    expect(mcp.mcp_server).toBe('exa');

    const kindNames = res.body.kinds.map(k => k.tool_kind);
    expect(kindNames).toEqual(expect.arrayContaining(['shell', 'file_edit', 'mcp']));
    expect(res.body.mcpServers).toEqual([
      expect.objectContaining({ mcp_server: 'exa', total_calls: 1 }),
    ]);
  });

  it('GET /api/analytics/file-changes finds the conversation that edited a file', async () => {
    const res = await request(app.app)
      .get('/api/analytics/file-changes?path=src/index.js').expect(200);
    expect(res.body.changes).toHaveLength(1);
    const change = res.body.changes[0];
    expect(change.path).toBe('/work/demo/src/index.js');
    expect(change.added_lines).toBe(2);
    expect(change.removed_lines).toBe(3);
    expect(change.change_count).toBe(1);
  });

  it('GET /api/analytics/file-changes validates its inputs', async () => {
    await request(app.app).get('/api/analytics/file-changes').expect(400);
    await request(app.app).get('/api/analytics/file-changes?path=x&limit=0').expect(400);
    await request(app.app).get('/api/analytics/file-changes?path=x&limit=abc').expect(400);
  });

  it('GET /api/conversations/:id/analytics reports real tool counts from the DB', async () => {
    // The DB-backed list rows carry a zeroed toolUsage placeholder; the
    // analytics route must read the tool_usage table instead of echoing it
    // (the modal showed "Tool Calls 0" for every conversation).
    const res = await request(app.app).get('/api/conversations/enriched/analytics').expect(200);
    const analytics = res.body.analytics;
    expect(analytics.toolCalls).toBe(4);
    expect(analytics.toolUsage.totalCalls).toBe(4);
    expect(analytics.toolUsage.uniqueTools).toBe(3);
    expect(analytics.toolUsage.totalErrors).toBe(1);
    expect(analytics.toolUsage.breakdown.Bash).toBe(2);
  });

  it('records src_line provenance on indexed messages', () => {
    const rows = app.databaseBackend.db.db.prepare(
      `SELECT src_line FROM messages WHERE src_line IS NOT NULL`
    ).all();
    // Every per-message record from the fixture carries its transcript line.
    expect(rows.length).toBeGreaterThan(0);
    const lines = rows.map(r => r.src_line);
    expect(Math.min(...lines)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...lines)).toBeLessThanOrEqual(4);
  });
});
