/**
 * FTS5 tool-content integration test.
 *
 * Boots the full pipeline against a temp ~/.claude, writes a session
 * whose tool inputs and tool results contain unique tokens that don't
 * appear in any user/assistant text, then drives the /api/search
 * contentSearch path and asserts FTS finds the session. This is the
 * regression net for PR 5 — if the indexer's `_extractTextContent`
 * stops flattening tool blocks, this test breaks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const request = require('supertest');

const { ChatsMobile } = require('../../src/chats-mobile.js');

const BASH_INPUT_TOKEN = 'cat-finder-tool-input-token-9b2e';
const BASH_RESULT_TOKEN = 'cat-finder-tool-result-token-4d8a';
const UNIQUE_FILE_PATH = '/private/var/folders/unique-readpath-c0ffee.txt';

function makeSessionLines() {
  // Mix of plain text, tool_use, and tool_result. None of the unique
  // tokens appear in user/assistant text, so a hit on them is proof
  // the indexer flattened the tool payload.
  return [
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-05-11T16:00:00Z',
      sessionId: 'fts-tool-session',
      cwd: '/tmp/fts-tool-test',
      message: { role: 'user', content: [{ type: 'text', text: 'please run that grep' }] },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      timestamp: '2026-05-11T16:00:01Z',
      sessionId: 'fts-tool-session',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          { type: 'text', text: 'running it now' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `grep ${BASH_INPUT_TOKEN} /tmp` } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a1',
      timestamp: '2026-05-11T16:00:02Z',
      sessionId: 'fts-tool-session',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: `found 1 match: ${BASH_RESULT_TOKEN}` }],
      },
    },
    {
      type: 'assistant',
      uuid: 'a2',
      parentUuid: 'u2',
      timestamp: '2026-05-11T16:00:03Z',
      sessionId: 'fts-tool-session',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: UNIQUE_FILE_PATH } },
        ],
        usage: { input_tokens: 8, output_tokens: 0 },
      },
    },
  ];
}

describe('FTS5 tool-content indexing', () => {
  let tempHome;
  let app;

  beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-explorer-fts-tool-'));
    const claudeDir = path.join(tempHome, '.claude');
    const projectDir = path.join(claudeDir, 'projects', 'fts-tool-test');
    await fs.ensureDir(projectDir);

    const sessionFile = path.join(projectDir, 'fts-tool-session.jsonl');
    const lines = makeSessionLines().map((entry) => JSON.stringify(entry)).join('\n');
    await fs.writeFile(sessionFile, lines + '\n');

    process.env.CLAUDE_DB_PATH = path.join(tempHome, 'conversations.db');

    app = new ChatsMobile({
      port: 0,
      claudeDir,
      verbose: false,
    });

    await app.initialize();
    await app.startServer();

    if (!app.useDatabaseBackend || !app.databaseBackend?.isInitialized) {
      throw new Error(
        `DB backend did not initialise (reason: ${app.databaseFallbackReason ?? 'unknown'}). ` +
        `This test only exercises the FTS path.`
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

  it('finds the session when searching for a token that only appears in a tool_use input', async () => {
    const res = await request(app.app)
      .post('/api/search')
      .send({ contentSearch: BASH_INPUT_TOKEN })
      .expect(200);

    const hit = res.body.results.find((r) => r.id === 'fts-tool-session');
    expect(hit).toBeDefined();
  });

  it('finds the session when searching for a token that only appears in a tool_result body', async () => {
    const res = await request(app.app)
      .post('/api/search')
      .send({ contentSearch: BASH_RESULT_TOKEN })
      .expect(200);

    const hit = res.body.results.find((r) => r.id === 'fts-tool-session');
    expect(hit).toBeDefined();
  });

  it('finds the session when searching for a file path passed as a tool_use input field', async () => {
    // FTS5 unicode61 tokenizer drops punctuation, so search for the
    // distinctive token portion of the path rather than the full
    // slash-delimited string.
    const res = await request(app.app)
      .post('/api/search')
      .send({ contentSearch: 'unique-readpath-c0ffee' })
      .expect(200);

    const hit = res.body.results.find((r) => r.id === 'fts-tool-session');
    expect(hit).toBeDefined();
  });
});
