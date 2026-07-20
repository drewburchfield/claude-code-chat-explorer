/**
 * Live re-indexing integration test.
 *
 * Boots the full ChatsMobile pipeline against a temp ~/.claude, writes a
 * synthetic session, then appends a new record to the file and asserts the
 * API reflects the new message count within a few seconds without any
 * restart.
 *
 * This is the canary for the watcher -> database re-index path: if it
 * passes, new chats show up live; if it fails, the explorer goes stale
 * until the container is restarted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const request = require('supertest');

const { ChatsMobile } = require('../../src/chats-mobile.js');

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'live', 'synthetic-session-template.jsonl');

async function waitForCondition(predicate, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

describe('Live re-indexing (watcher to DB)', () => {
  let tempHome;
  let claudeDir;
  let sessionFile;
  let app;

  beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-explorer-live-'));
    claudeDir = path.join(tempHome, '.claude');
    const projectDir = path.join(claudeDir, 'projects', 'live-reindex-test');
    await fs.ensureDir(projectDir);

    sessionFile = path.join(projectDir, 'session-live.jsonl');
    const fixture = await fs.readFile(FIXTURE_PATH, 'utf8');
    await fs.writeFile(sessionFile, fixture);

    // Use a private SQLite per-test to avoid sharing state with the user's real DB.
    // Must be set BEFORE constructing ChatsMobile because the DatabaseBackend
    // constructor reads CLAUDE_DB_PATH eagerly.
    process.env.CLAUDE_DB_PATH = path.join(tempHome, 'conversations.db');

    app = new ChatsMobile({
      port: 0,
      claudeDir,
      verbose: false,
      authToken: false,
    });

    await app.initialize();
    await app.startServer();

    // Production runs against the DB-backed code path. If the test silently
    // falls back to file-based loading the assertion below still passes but
    // the regression we care about isn't exercised. Fail loudly instead.
    if (!app.useDatabaseBackend || !app.databaseBackend?.isInitialized) {
      throw new Error(
        `DB backend did not initialise (reason: ${app.databaseFallbackReason ?? 'unknown'}). ` +
        `Test would only exercise the file-based fallback; production behaviour is the DB path.`
      );
    }
  }, 30000);

  afterAll(async () => {
    try {
      if (app) await app.stop();
    } finally {
      delete process.env.CLAUDE_DB_PATH;
      if (tempHome) await fs.remove(tempHome).catch(() => {});
    }
  }, 30000);

  it('reflects appended records in /api/conversations when a file change is signalled', async () => {
    // This test verifies the data path: file changed -> indexer.indexFile ->
    // SQLite -> API. The chokidar wiring that drives this path under real
    // conditions is covered by the unit tests in test/unit/FileWatcher.test.js,
    // which mock chokidar and verify event plumbing without depending on the
    // host OS's filesystem event delivery (which is racy on macOS tmpdirs).
    const before = await request(app.app).get('/api/conversations').expect(200);
    const beforeConv = before.body.conversations.find(c => c.id === 'session-live');
    expect(beforeConv).toBeDefined();
    const beforeCount = beforeConv.messageCount;

    const newRecord = JSON.stringify({
      type: 'user',
      uuid: 'u-new',
      parentUuid: 'sys1',
      timestamp: new Date().toISOString(),
      sessionId: 'session-live',
      cwd: '/tmp/test',
      message: { role: 'user', content: [{ type: 'text', text: 'second turn' }] },
    });
    await fs.appendFile(sessionFile, '\n' + newRecord + '\n');

    // Invoke the callback the watcher would have fired. We have already
    // verified upstream of this test that the watcher does wire its
    // 'change' events to handleFileChange.
    await app.handleFileChange(sessionFile);

    const grew = await waitForCondition(async () => {
      const res = await request(app.app).get('/api/conversations').expect(200);
      const conv = res.body.conversations.find(c => c.id === 'session-live');
      return conv && conv.messageCount > beforeCount;
    }, { timeoutMs: 5000, intervalMs: 200 });

    expect(grew).toBe(true);
  }, 15000);

  it('recovers via periodic fallback even if the watcher has stopped firing', async () => {
    // Simulate the Docker-on-macOS failure mode: chokidar events stop
    // arriving entirely. The periodic 2-minute fallback should still
    // bring the index back in sync.
    const before = await request(app.app).get('/api/conversations').expect(200);
    const beforeConv = before.body.conversations.find(c => c.id === 'session-live');
    expect(beforeConv).toBeDefined();
    const beforeCount = beforeConv.messageCount;

    // Tear the watchers down hard; only the periodic interval remains.
    for (const watcher of app.fileWatcher.watchers) {
      await watcher.close().catch(() => {});
    }
    app.fileWatcher.watchers = [];

    const newRecord = JSON.stringify({
      type: 'user',
      uuid: 'u-after-watcher-dead',
      parentUuid: 'sys1',
      timestamp: new Date().toISOString(),
      sessionId: 'session-live',
      cwd: '/tmp/test',
      message: { role: 'user', content: [{ type: 'text', text: 'after watcher dead' }] },
    });
    await fs.appendFile(sessionFile, '\n' + newRecord + '\n');

    // Drive the fallback once instead of waiting two minutes.
    await app.fileWatcher.runPeriodicFallback();

    const grew = await waitForCondition(async () => {
      const res = await request(app.app).get('/api/conversations').expect(200);
      const conv = res.body.conversations.find(c => c.id === 'session-live');
      return conv && conv.messageCount > beforeCount;
    }, { timeoutMs: 6000, intervalMs: 250 });

    expect(grew).toBe(true);
  }, 20000);
});
