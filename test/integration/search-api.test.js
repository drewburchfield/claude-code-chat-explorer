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

  it('POST /api/search filters by model', async () => {
    const res = await request(app.app).post('/api/search')
      .send({ contentSearch: 'the', model: 'claude-sonnet-4' }).expect(200);
    const ids = res.body.results.map(r => r.id);
    expect(ids).toEqual(['b']);
  });
});
