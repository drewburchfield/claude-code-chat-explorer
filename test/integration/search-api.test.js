/**
 * Integration tests for the SearchService-backed REST surface:
 * GET /api/facets and POST /api/search filters/operators.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const request = require('supertest');
const { ChatsMobile } = require('../../src/chats-mobile.js');

function session(id, model, content) {
  return [
    { type: 'user', message: { role: 'user', content }, cwd: `/work/${id}` },
    { type: 'assistant', message: { role: 'assistant', model, content: 'ok' } },
  ];
}

describe('SearchService REST surface', () => {
  let tempHome, app;

  beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-explorer-searchapi-'));
    const claudeDir = path.join(tempHome, '.claude');
    const projA = path.join(claudeDir, 'projects', 'alpha');
    const projB = path.join(claudeDir, 'projects', 'beta');
    await fs.ensureDir(projA);
    await fs.ensureDir(projB);
    await fs.writeFile(path.join(projA, 'a.jsonl'),
      session('a', 'claude-opus-4', 'the quick brown fox').map(l => JSON.stringify(l)).join('\n') + '\n');
    await fs.writeFile(path.join(projB, 'b.jsonl'),
      session('b', 'claude-sonnet-4', 'the lazy dog sleeps').map(l => JSON.stringify(l)).join('\n') + '\n');

    // A subagent conversation carrying a unique token, to exercise
    // subagentsOnly + query (Devin finding: the intersection used to be empty).
    const subDir = path.join(projA, 'parent-xyz', 'subagents');
    await fs.ensureDir(subDir);
    await fs.writeFile(path.join(subDir, 'agent-1.jsonl'),
      session('s', 'claude-opus-4', 'subagentonlytoken explored the fox').map(l => JSON.stringify(l)).join('\n') + '\n');

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

  it('GET /api/facets returns projects, models and a date range', async () => {
    const res = await request(app.app).get('/api/facets').expect(200);
    expect(res.body.projects).toEqual(expect.arrayContaining(['a', 'b']));
    expect(res.body.models).toEqual(expect.arrayContaining(['claude-opus-4', 'claude-sonnet-4']));
    expect(res.body.dateRange).toHaveProperty('min');
    expect(res.body.dateRange).toHaveProperty('max');
  });

  it('POST /api/search supports the OR operator', async () => {
    const res = await request(app.app).post('/api/search')
      .send({ contentSearch: 'fox OR dog' }).expect(200);
    const ids = res.body.results.map(r => r.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('POST /api/search filters by project', async () => {
    const res = await request(app.app).post('/api/search')
      .send({ contentSearch: 'the', project: 'a' }).expect(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toEqual(['a']);
  });

  it('POST /api/search with subagentsOnly + a content query returns the subagent (not empty)', async () => {
    const res = await request(app.app).post('/api/search')
      .send({ contentSearch: 'subagentonlytoken', subagentsOnly: true }).expect(200);
    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    expect(res.body.results.every(r => r.isSubagent)).toBe(true);
  });

  it('POST /api/search applies project filter with NO content query (browse mode)', async () => {
    const res = await request(app.app).post('/api/search')
      .send({ project: 'a', includeSubagents: true }).expect(200);
    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    expect(res.body.results.every(r => r.project === 'a')).toBe(true);
  });

  it('POST /api/search applies subagentsOnly with NO content query (browse mode)', async () => {
    const res = await request(app.app).post('/api/search')
      .send({ subagentsOnly: true }).expect(200);
    expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    expect(res.body.results.every(r => r.isSubagent)).toBe(true);
  });

  it('POST /api/search role=user finds a user-message term; role=assistant does not', async () => {
    // 'fox' is in conversation a's USER message; assistant said only 'ok'.
    const u = await request(app.app).post('/api/search').send({ contentSearch: 'fox', role: 'user' }).expect(200);
    expect(u.body.results.map(r => r.id)).toContain('a');
    const a = await request(app.app).post('/api/search').send({ contentSearch: 'fox', role: 'assistant' }).expect(200);
    expect(a.body.results.map(r => r.id)).not.toContain('a');
  });

  it('GET /api/facets includes the role enum', async () => {
    const res = await request(app.app).get('/api/facets').expect(200);
    expect(res.body.roles).toEqual(expect.arrayContaining(['user', 'assistant', 'system', 'tool']));
  });

  it('POST /api/search filters by model', async () => {
    const res = await request(app.app).post('/api/search')
      .send({ contentSearch: 'the', model: 'claude-sonnet-4' }).expect(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toEqual(['b']);
  });

  describe('GET /api/conversations projection and paging', () => {
    it('returns the full record by default (unchanged for existing consumers)', async () => {
      const res = await request(app.app).get('/api/conversations').expect(200);
      expect(res.body.conversations.length).toBeGreaterThan(0);
      expect(res.body.conversations[0]).toHaveProperty('filePath');
    });

    it('view=summary omits filePath and other fields no list row renders', async () => {
      const res = await request(app.app).get('/api/conversations?view=summary').expect(200);
      const row = res.body.conversations[0];
      // filePath is the largest single field and an absolute host path; it must
      // not reach the browser in the summary view.
      expect(row).not.toHaveProperty('filePath');
      expect(row).not.toHaveProperty('toolUsage');
      // ...but everything a row actually renders is still present.
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('project');
      expect(row).toHaveProperty('lastModified');
      expect(row).toHaveProperty('messageCount');
    });

    it('limit caps the page and returns a cursor; before= walks without overlap', async () => {
      const first = await request(app.app).get('/api/conversations?limit=1').expect(200);
      expect(first.body.conversations).toHaveLength(1);
      expect(first.body.nextCursor).toBeTruthy();

      const second = await request(app.app)
        .get(`/api/conversations?limit=1&before=${encodeURIComponent(first.body.nextCursor)}`)
        .expect(200);

      // Keyset, not OFFSET: the second page must not repeat the first row.
      const firstId = first.body.conversations[0].id;
      expect(second.body.conversations.map(c => c.id)).not.toContain(firstId);
    });

    it('omits nextCursor when the whole set fits in the page', async () => {
      const res = await request(app.app).get('/api/conversations?limit=1000').expect(200);
      expect(res.body.nextCursor).toBeNull();
    });
  });
});
