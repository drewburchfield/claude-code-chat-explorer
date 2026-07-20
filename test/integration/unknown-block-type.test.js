/**
 * Forward-compat: unknown block types should reach the API response so the
 * client can render a placeholder for them rather than dropping them.
 *
 * Today the parser preserves the full content array as-is (unknown block
 * types passed through). This test pins that invariant down so a future
 * refactor of parseAndCorrelateToolMessages cannot accidentally start
 * filtering blocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const request = require('supertest');

const { ChatsMobile } = require('../../src/chats-mobile.js');
const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'live', 'synthetic-session-template.jsonl');

describe('Unknown block type forward-compat', () => {
  let tempHome;
  let app;
  let claudeDir;

  beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-explorer-unknown-blocks-'));
    claudeDir = path.join(tempHome, '.claude');
    const projectDir = path.join(claudeDir, 'projects', 'unknown-blocks-test');
    await fs.ensureDir(projectDir);

    const fixture = await fs.readFile(FIXTURE_PATH, 'utf8');
    await fs.writeFile(path.join(projectDir, 'session-live.jsonl'), fixture);

    process.env.CLAUDE_DB_PATH = path.join(tempHome, 'conversations.db');
    app = new ChatsMobile({ port: 0, claudeDir, verbose: false, authToken: false });
    await app.initialize();
    await app.startServer();
  }, 30000);

  afterAll(async () => {
    try { if (app) await app.stop(); }
    finally {
      delete process.env.CLAUDE_DB_PATH;
      if (tempHome) await fs.remove(tempHome).catch(() => {});
    }
  }, 30000);

  it('keeps a thinking block intact in /api/conversations/:id/messages', async () => {
    const res = await request(app.app)
      .get('/api/conversations/session-live/messages')
      .expect(200);

    const allBlocks = res.body.messages.flatMap(m => {
      if (Array.isArray(m.content)) return m.content;
      if (m.content && typeof m.content === 'object') return [m.content];
      return [];
    });

    const thinkingBlock = allBlocks.find(b => b && b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock.thinking).toBe('considering');
  });

  it('preserves an image block carried alongside a tool_result on the same user message', async () => {
    // Prior parser behaviour: a user message containing tool_result + image
    // had the whole entry skipped after correlation, silently dropping the
    // image. Pin the new behaviour down so it can't regress.
    const res = await request(app.app)
      .get('/api/conversations/session-live/messages')
      .expect(200);

    const allBlocks = res.body.messages.flatMap(m => {
      if (Array.isArray(m.content)) return m.content;
      if (m.content && typeof m.content === 'object') return [m.content];
      return [];
    });
    const imageBlock = allBlocks.find(b => b && b.type === 'image');
    expect(imageBlock).toBeDefined();
    expect(imageBlock.source.type).toBe('base64');
    expect(imageBlock.source.media_type).toBe('image/png');
  });

  it('does not crash on a record whose top-level type is unknown', async () => {
    // The fixture contains a fictitious `queue-operation` record. The
    // current parser drops it (it gates on type === 'user' | 'assistant'),
    // which is fine; the contract here is "does not throw and still
    // returns the other messages".
    const res = await request(app.app)
      .get('/api/conversations/session-live/messages')
      .expect(200);
    expect(Array.isArray(res.body.messages)).toBe(true);
    expect(res.body.messages.length).toBeGreaterThan(0);
  });
});
