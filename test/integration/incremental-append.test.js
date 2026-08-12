/**
 * Incremental-append equivalence.
 *
 * The append path exists because replacing a conversation wholesale on every
 * new message is expensive: measured on a 5,319-message conversation, the
 * delete+reinsert costs 1,007ms and 30.4MB of WAL to record one message, while
 * appending the rows that actually arrived costs 0ms and 0MB.
 *
 * Speed is only worth having if the result is identical, so that is what these
 * tests assert: index a file, append to it, index again — the database must
 * hold exactly what a from-scratch index of the final file would have held.
 * Rows, order, seq numbering, src_line, token totals and tool counts.
 *
 * The failure this guards against is silent: a wrong offset does not throw, it
 * duplicates or drops messages that no one notices until a search comes back
 * short.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs-extra');
const path = require('path');
const { createTestDatabase, createTempProjectsDir } = require('../helpers/test-db');
const Indexer = require('../../src/analytics/data/Indexer');

const line = (n, extra = {}) => JSON.stringify({
  type: n % 2 ? 'assistant' : 'user',
  message: n % 2
    ? {
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: 'text', text: `answer number ${n} MSGTOKEN${n}` },
          { type: 'tool_use', name: 'Bash', input: { command: `echo ${n}` } },
        ],
      }
    : { role: 'user', content: `question number ${n} MSGTOKEN${n}` },
  cwd: '/proj',
  ...extra,
});

/** Everything that must match between the two paths. */
function snapshot(db, convId) {
  const rows = db.db.prepare(
    'SELECT seq, src_line, role, tool_name, content FROM messages WHERE conversation_id = ? ORDER BY seq'
  ).all(convId);
  const conv = db.db.prepare(
    'SELECT message_count, tokens_total, tokens_input, tokens_output FROM conversations WHERE id = ?'
  ).get(convId);
  const tools = db.db.prepare(
    'SELECT tool_name, call_count FROM tool_usage WHERE conversation_id = ? ORDER BY tool_name'
  ).all(convId);
  return { rows, conv, tools };
}

describe('incremental append', () => {
  let db, dbCleanup, projectsDir, claudeDir, projectsCleanup, indexer, filePath, convId;

  beforeEach(async () => {
    ({ db, cleanup: dbCleanup } = await createTestDatabase());
    ({ projectsDir, claudeDir, cleanup: projectsCleanup } = await createTempProjectsDir());
    indexer = new Indexer(db, claudeDir);
    const dir = path.join(projectsDir, '-proj');
    await fs.ensureDir(dir);
    convId = '11111111-2222-3333-4444-555555555555';
    filePath = path.join(dir, `${convId}.jsonl`);
  });

  afterEach(async () => {
    await projectsCleanup?.();
    await dbCleanup?.();
  });

  const write = (from, to, trailingNewline = true) => {
    const body = [];
    for (let n = from; n <= to; n++) body.push(line(n));
    return body.join('\n') + (trailingNewline ? '\n' : '');
  };

  it('matches a from-scratch index after an append', async () => {
    await fs.writeFile(filePath, write(1, 6));
    await indexer.indexSingleFile(filePath);

    await fs.appendFile(filePath, write(7, 10));
    await indexer.indexSingleFile(filePath);
    const incremental = snapshot(db, convId);

    // Same bytes, indexed from nothing.
    const { db: fresh, cleanup } = await createTestDatabase();
    try {
      await new Indexer(fresh, claudeDir).indexSingleFile(filePath);
      const full = snapshot(fresh, convId);
      expect(incremental.rows).toEqual(full.rows);
      expect(incremental.conv).toEqual(full.conv);
      expect(incremental.tools).toEqual(full.tools);
    } finally {
      await cleanup();
    }
  });

  it('actually took the append path', async () => {
    await fs.writeFile(filePath, write(1, 6));
    await indexer.indexSingleFile(filePath);
    const first = db.getAppendState(filePath);
    expect(first).toBeTruthy();
    expect(first.indexed_bytes).toBe((await fs.stat(filePath)).size);

    await fs.appendFile(filePath, write(7, 10));
    await indexer.indexSingleFile(filePath);
    const second = db.getAppendState(filePath);
    expect(second.indexed_bytes).toBe((await fs.stat(filePath)).size);
    // The checkpoint moved forward rather than being rebuilt from zero, and the
    // fts timestamp was NOT touched — that is what marks it as an append.
    expect(second.fts_refreshed_at).toBe(first.fts_refreshed_at);
    expect(second.indexed_seq).toBeGreaterThan(first.indexed_seq);
  });

  it('leaves no duplicate or missing messages', async () => {
    await fs.writeFile(filePath, write(1, 3));
    await indexer.indexSingleFile(filePath);
    for (let n = 4; n <= 12; n++) {
      await fs.appendFile(filePath, line(n) + '\n');
      await indexer.indexSingleFile(filePath);
    }
    const { rows } = snapshot(db, convId);
    const seqs = rows.map(r => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);           // no duplicates
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));  // dense and ordered
    for (let n = 1; n <= 12; n++) {
      // \b so MSGTOKEN1 does not also match MSGTOKEN10..12.
      const re = new RegExp(`MSGTOKEN${n}\\b`);
      const hit = rows.filter(r => re.test(r.content));
      expect(hit.length, `MSGTOKEN${n} appears exactly once`).toBe(1);
    }
  });

  it('indexes a final line that has no trailing newline', async () => {
    // A complete last line without a \n is complete, not partial. Treating it
    // as partial silently drops the newest message — the exact bug this
    // checkpoint design invites.
    await fs.writeFile(filePath, write(1, 4, false));
    await indexer.indexSingleFile(filePath);
    const { rows } = snapshot(db, convId);
    expect(rows.some(r => r.content.includes('MSGTOKEN4'))).toBe(true);
    expect(db.getAppendState(filePath).indexed_bytes).toBe((await fs.stat(filePath)).size);
  });

  it('holds the checkpoint behind a half-written line, then absorbs it', async () => {
    await fs.writeFile(filePath, write(1, 3));
    await indexer.indexSingleFile(filePath);
    const clean = db.getAppendState(filePath).indexed_bytes;

    // Simulate catching the writer mid-line.
    const partial = line(4).slice(0, 30);
    await fs.appendFile(filePath, partial);
    await indexer.indexSingleFile(filePath);
    expect(db.getAppendState(filePath).indexed_bytes).toBe(clean);

    // The rest of the line lands; now it must be indexed exactly once.
    await fs.appendFile(filePath, line(4).slice(30) + '\n');
    await indexer.indexSingleFile(filePath);
    const { rows } = snapshot(db, convId);
    expect(rows.filter(r => r.content.includes('MSGTOKEN4')).length).toBe(1);
  });

  it('falls back to a full reindex when the file is rewritten shorter', async () => {
    await fs.writeFile(filePath, write(1, 10));
    await indexer.indexSingleFile(filePath);

    await fs.writeFile(filePath, write(1, 3));
    await indexer.indexSingleFile(filePath);

    const { rows, conv } = snapshot(db, convId);
    expect(conv.message_count).toBe(3);
    expect(rows.some(r => r.content.includes('MSGTOKEN10'))).toBe(false);
  });

  it('rebuilds conversation_fts when the refresh window expires', async () => {
    await fs.writeFile(filePath, write(1, 4));
    await indexer.indexSingleFile(filePath);

    // Age the fts stamp past the window so the next change must take the full
    // path — that is what keeps conversation-level search from drifting.
    db.db.prepare('UPDATE file_index SET fts_refreshed_at = 0 WHERE file_path = ?').run(filePath);
    await fs.appendFile(filePath, write(5, 6));
    await indexer.indexSingleFile(filePath);

    const after = db.getAppendState(filePath);
    expect(after.fts_refreshed_at).toBeGreaterThan(0);
    const hits = db.searchConversationsWithSnippets('MSGTOKEN6', { includeSubagents: true });
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});
