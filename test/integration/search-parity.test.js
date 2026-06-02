/**
 * FTS-vs-grep parity backbone test.
 *
 * The premise of the recall-parity work is "search matches what's on disk."
 * This test encodes that contract: a fixture conversation carries a unique
 * token in every block type we index (text, thinking, tool_use input,
 * tool_result, and a top-level system entry), plus a token buried past the
 * old 100KB per-conversation cap. For each token we assert two things:
 *   1. grep would find it (the token is literally on disk), and
 *   2. FTS finds the conversation (searchConversationsWithSnippets).
 * A control token that is NOT on disk must NOT be found.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs-extra');
const path = require('path');
const { createTestDatabase, createTempProjectsDir } = require('../helpers/test-db');
const Indexer = require('../../src/analytics/data/Indexer');

// Pure-alphanumeric tokens so the unicode61 tokenizer keeps each as one term.
const TOKENS = {
  text: 'TEXTTOKENZZ',
  thinking: 'THINKTOKENZZ',
  toolInput: 'TOOLINPUTTOKENZZ',
  toolResult: 'TOOLRESULTTOKENZZ',
  system: 'SYSTEMTOKENZZ',
  deep: 'DEEPTAILTOKENZZ', // placed past the old 100KB cap
};
const ABSENT_TOKEN = 'NEVERWRITTENTOKENZZ';

describe('FTS-vs-grep parity', () => {
  let db, dbCleanup, projectsDir, claudeDir, projectsCleanup, indexer, filePath;

  beforeEach(async () => {
    ({ db, cleanup: dbCleanup } = await createTestDatabase());
    ({ projectsDir, claudeDir, cleanup: projectsCleanup } = await createTempProjectsDir());
    indexer = new Indexer(db, claudeDir);

    const lines = [
      { type: 'user', message: { role: 'user', content: `please ${TOKENS.text} now` }, cwd: '/proj' },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [
            { type: 'thinking', thinking: `reasoning about ${TOKENS.thinking}` },
            { type: 'text', text: 'here is the answer' },
            { type: 'tool_use', name: 'Bash', input: { command: `echo ${TOKENS.toolInput}` } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'x', content: `output ${TOKENS.toolResult}` }],
        },
      },
      { type: 'system', subtype: 'reminder', content: `system note ${TOKENS.system}` },
      // A large message with the token buried at the end, past the old 100KB cap.
      { type: 'assistant', message: { role: 'assistant', content: 'q'.repeat(120000) + ` ${TOKENS.deep}` } },
    ];

    const dir = path.join(projectsDir, '-proj');
    await fs.ensureDir(dir);
    filePath = path.join(dir, 'parity.jsonl');
    await fs.writeFile(filePath, lines.map(l => JSON.stringify(l)).join('\n'));

    const origLog = console.log, origWarn = console.warn;
    console.log = () => {}; console.warn = () => {};
    await indexer.runFullIndex();
    console.log = origLog; console.warn = origWarn;
  });

  afterEach(async () => {
    await dbCleanup();
    await projectsCleanup();
  });

  it('indexes the fixture conversation', () => {
    expect(db.getConversations({ includeSubagents: true }).length).toBe(1);
  });

  for (const [kind, token] of Object.entries(TOKENS)) {
    it(`finds the ${kind} token that grep would find on disk`, async () => {
      // grep parity: the token is literally on disk.
      const raw = await fs.readFile(filePath, 'utf8');
      expect(raw.includes(token)).toBe(true);

      // FTS parity: search finds the conversation.
      const results = db.searchConversationsWithSnippets(token, { includeSubagents: true });
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('does not find a token that was never written to disk', async () => {
    const raw = await fs.readFile(filePath, 'utf8');
    expect(raw.includes(ABSENT_TOKEN)).toBe(false);
    const results = db.searchConversationsWithSnippets(ABSENT_TOKEN, { includeSubagents: true });
    expect(results.length).toBe(0);
  });
});
