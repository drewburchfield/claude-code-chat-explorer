/**
 * Indexer Unit Tests
 *
 * Tests for JSONL file indexing including:
 * - Subagent detection and path parsing
 * - JSONL streaming parse
 * - Content extraction
 * - Tool name extraction
 * - Project path extraction
 * - Malformed file handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const path = require('path');
const fs = require('fs-extra');
const {
  createTestDatabase,
  createTempProjectsDir,
  setupFixturesInProjectsDir,
  setupSubagentFixture,
  getConversationFixturePath,
} = require('../helpers/test-db');

// Import Indexer
const Indexer = require('../../src/analytics/data/Indexer');

describe('Indexer', () => {
  let db;
  let dbCleanup;
  let projectsDir;
  let claudeDir;
  let projectsCleanup;
  let indexer;

  beforeEach(async () => {
    // Create test database
    const dbResult = await createTestDatabase();
    db = dbResult.db;
    dbCleanup = dbResult.cleanup;

    // Create temp projects directory
    const projectsResult = await createTempProjectsDir();
    projectsDir = projectsResult.projectsDir;
    claudeDir = projectsResult.claudeDir;
    projectsCleanup = projectsResult.cleanup;

    // Create indexer instance
    indexer = new Indexer(db, claudeDir);
  });

  afterEach(async () => {
    await dbCleanup();
    await projectsCleanup();
  });

  describe('_detectSubagent()', () => {
    it('detects subagent from path with /subagents/ directory', () => {
      const subagentPath = '/Users/test/.claude/projects/-path/abc123-def456/subagents/agent-1.jsonl';
      const result = indexer._detectSubagent(subagentPath);

      expect(result.isSubagent).toBe(true);
      expect(result.parentId).toBe('abc123-def456');
    });

    it('returns false for regular conversation paths', () => {
      const regularPath = '/Users/test/.claude/projects/-path/conversation.jsonl';
      const result = indexer._detectSubagent(regularPath);

      expect(result.isSubagent).toBe(false);
      expect(result.parentId).toBeNull();
    });

    it('extracts parent ID from various path formats', () => {
      const paths = [
        '/path/abc-123/subagents/agent-1.jsonl',
        '/some/deep/path/def-456-789/subagents/agent-task.jsonl',
        '/projects/-Users-test/parent-uuid-here/subagents/agent-2.jsonl',
      ];

      const results = paths.map(p => indexer._detectSubagent(p));

      expect(results[0].parentId).toBe('abc-123');
      expect(results[1].parentId).toBe('def-456-789');
      expect(results[2].parentId).toBe('parent-uuid-here');
    });

    it('handles edge case with subagents at beginning of path', () => {
      const edgePath = 'subagents/agent-1.jsonl';
      const result = indexer._detectSubagent(edgePath);

      // subagentIdx is 0, which > 0 is false
      expect(result.isSubagent).toBe(false);
    });
  });

  describe('_parseJsonlStreaming()', () => {
    it('extracts cwd from conversation', async () => {
      const fixturePath = getConversationFixturePath('simple.jsonl');
      const result = await indexer._parseJsonlStreaming(fixturePath);

      expect(result.cwd).toBe('/Users/testuser/projects/my-awesome-project');
    });

    it('counts user and assistant messages', async () => {
      const fixturePath = getConversationFixturePath('simple.jsonl');
      const result = await indexer._parseJsonlStreaming(fixturePath);

      // simple.jsonl has 3 user messages and 3 assistant messages
      expect(result.messageCount).toBe(6);
    });

    it('calculates token usage from assistant messages', async () => {
      const fixturePath = getConversationFixturePath('simple.jsonl');
      const result = await indexer._parseJsonlStreaming(fixturePath);

      expect(result.tokenUsage.input).toBeGreaterThan(0);
      expect(result.tokenUsage.output).toBeGreaterThan(0);
      expect(result.tokenUsage.total).toBe(result.tokenUsage.input + result.tokenUsage.output);
    });

    it('extracts primary model from messages', async () => {
      const fixturePath = getConversationFixturePath('simple.jsonl');
      const result = await indexer._parseJsonlStreaming(fixturePath);

      expect(result.modelInfo.primaryModel).toBe('claude-sonnet-4-20250514');
    });

    it('extracts tool usage from messages', async () => {
      const fixturePath = getConversationFixturePath('with-tools.jsonl');
      const result = await indexer._parseJsonlStreaming(fixturePath);

      expect(result.toolUsage.total).toBeGreaterThan(0);
      expect(result.toolUsage.tools).toHaveProperty('Read');
      expect(result.toolUsage.tools).toHaveProperty('Write');
      expect(result.toolUsage.tools).toHaveProperty('Bash');
    });

    it('generates searchable content from messages', async () => {
      const fixturePath = getConversationFixturePath('simple.jsonl');
      const result = await indexer._parseJsonlStreaming(fixturePath);

      expect(result.searchableContent).toContain('reverse a string');
      expect(result.searchableContent).toContain('JavaScript');
    });

    it('handles malformed JSONL gracefully', async () => {
      const fixturePath = getConversationFixturePath('malformed.jsonl');
      const result = await indexer._parseJsonlStreaming(fixturePath);

      // Should still parse valid lines
      expect(result.messageCount).toBeGreaterThan(0);
      expect(result.cwd).toBe('/Users/testuser/projects/malformed-test');
    });
  });

  describe('_parseJsonlStreaming() recall parity', () => {
    async function writeJsonl(lines) {
      const p = path.join(projectsDir, `recall-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
      await fs.writeFile(p, lines.map(l => JSON.stringify(l)).join('\n'));
      return p;
    }

    it('indexes system entry content (string content, no message wrapper)', async () => {
      const p = await writeJsonl([
        { type: 'user', message: { role: 'user', content: 'hi' }, cwd: '/x' },
        { type: 'system', subtype: 'reminder', content: 'reminder mentions SYS_UNIQUE_TOKEN here' },
      ]);
      const result = await indexer._parseJsonlStreaming(p);
      expect(result.searchableContent).toContain('SYS_UNIQUE_TOKEN');
    });

    it('indexes queued user message content (queue-operation)', async () => {
      const p = await writeJsonl([
        { type: 'queue-operation', operation: 'enqueue', content: 'queued ask about QUEUE_UNIQUE_TOKEN' },
        { type: 'user', message: { role: 'user', content: 'hi' }, cwd: '/x' },
      ]);
      const result = await indexer._parseJsonlStreaming(p);
      expect(result.searchableContent).toContain('QUEUE_UNIQUE_TOKEN');
    });

    it('indexes attachment payloads (e.g. pasted file content)', async () => {
      const p = await writeJsonl([
        { type: 'attachment', attachment: { type: 'edited_text_file', addedLines: 'config has ATTACH_UNIQUE_TOKEN' } },
        { type: 'user', message: { role: 'user', content: 'hi' }, cwd: '/x' },
      ]);
      const result = await indexer._parseJsonlStreaming(p);
      expect(result.searchableContent).toContain('ATTACH_UNIQUE_TOKEN');
    });

    it('indexes compaction summary text', async () => {
      const p = await writeJsonl([
        { type: 'summary', summary: 'prior context about SUM_UNIQUE_TOKEN', leafUuid: 'abc' },
        { type: 'user', message: { role: 'user', content: 'continue' }, cwd: '/x' },
      ]);
      const result = await indexer._parseJsonlStreaming(p);
      expect(result.searchableContent).toContain('SUM_UNIQUE_TOKEN');
    });

    it('does not cap a single message at 2000 chars', async () => {
      const big = 'm'.repeat(8000) + ' MSG_TAIL_TOKEN';
      const p = await writeJsonl([
        { type: 'user', message: { role: 'user', content: big }, cwd: '/x' },
      ]);
      const result = await indexer._parseJsonlStreaming(p);
      expect(result.searchableContent).toContain('MSG_TAIL_TOKEN');
    });

    it('does not cap total conversation content at 100k', async () => {
      const lines = [];
      for (let i = 0; i < 60; i++) {
        lines.push({ type: 'user', message: { role: 'user', content: 'z'.repeat(2000) } });
      }
      lines.push({ type: 'assistant', message: { role: 'assistant', content: 'FAR_TAIL_TOKEN' } });
      const p = await writeJsonl(lines);
      const result = await indexer._parseJsonlStreaming(p);
      expect(result.searchableContent.length).toBeGreaterThan(100000);
      expect(result.searchableContent).toContain('FAR_TAIL_TOKEN');
    });
  });

  describe('_extractTextContent()', () => {
    it('extracts text from string content', () => {
      const content = 'Simple string content';
      const result = indexer._extractTextContent(content);

      expect(result).toBe('Simple string content');
    });

    it('extracts text from array of content blocks', () => {
      const content = [
        { type: 'text', text: 'First paragraph' },
        { type: 'text', text: 'Second paragraph' },
      ];
      const result = indexer._extractTextContent(content);

      expect(result).toContain('First paragraph');
      expect(result).toContain('Second paragraph');
    });

    it('flattens tool_use blocks with a [TOOL:<name>] prefix so the input is searchable', () => {
      const content = [
        { type: 'text', text: 'Running a command' },
        { type: 'tool_use', name: 'Bash', input: { command: 'echo cat-finder-token-12345' } },
      ];
      const result = indexer._extractTextContent(content);

      expect(result).toContain('Running a command');
      expect(result).toContain('[TOOL:Bash]');
      expect(result).toContain('cat-finder-token-12345');
    });

    it('flattens tool_result blocks with a [TOOL_RESULT] prefix', () => {
      const content = [
        { type: 'tool_result', tool_use_id: 'abc', content: 'README.md\npackage.json\nUNIQUE_FILENAME_XYZ.txt' },
      ];
      const result = indexer._extractTextContent(content);

      expect(result).toContain('[TOOL_RESULT]');
      expect(result).toContain('UNIQUE_FILENAME_XYZ.txt');
    });

    it('extracts text from tool_result whose content is an array of text/image blocks', () => {
      const content = [
        {
          type: 'tool_result',
          tool_use_id: 'abc',
          content: [
            { type: 'text', text: 'first chunk of stdout' },
            { type: 'image', source: { type: 'base64', data: 'ignored-bytes' } },
            { type: 'text', text: 'second chunk of stdout' },
          ],
        },
      ];
      const result = indexer._extractTextContent(content);

      expect(result).toContain('first chunk of stdout');
      expect(result).toContain('second chunk of stdout');
      expect(result).toContain('[image]');
      expect(result).not.toContain('ignored-bytes');
    });

    it('keeps tool content up to the 256KB safety ceiling so search matches on-disk text', () => {
      // Recall parity: we no longer truncate at 2000 chars. The only cap is a
      // 256KB-per-block safety ceiling to guard against pathological base64
      // that slips past the image filter. A realistic 100KB tool_result must
      // survive intact, including a tail token grep would find on disk.
      const body = 'X'.repeat(100000) + ' TOOL_TAIL_TOKEN';
      const content = [
        { type: 'tool_result', tool_use_id: 'abc', content: body },
      ];
      const result = indexer._extractTextContent(content);
      expect(result).toContain('TOOL_TAIL_TOKEN');
    });

    it('caps a single block at the 256KB safety ceiling', () => {
      const huge = 'X'.repeat(300000);
      const content = [
        { type: 'tool_result', tool_use_id: 'abc', content: huge },
      ];
      const result = indexer._extractTextContent(content);
      expect(result.length).toBeLessThanOrEqual('[TOOL_RESULT] '.length + 256 * 1024);
      // ...but it keeps far more than the old 2000-char cap.
      expect(result.length).toBeGreaterThan(200000);
    });

    it('indexes thinking blocks so reasoning is searchable', () => {
      const content = [
        { type: 'thinking', thinking: 'UNIQ_THINK_TOKEN private reasoning' },
        { type: 'text', text: 'visible answer' },
      ];
      const result = indexer._extractTextContent(content);
      expect(result).toContain('[THINKING]');
      expect(result).toContain('UNIQ_THINK_TOKEN');
      expect(result).toContain('visible answer');
    });

    it('does not truncate a long text block', () => {
      const big = 'y'.repeat(8000) + ' TEXT_TAIL_TOKEN';
      const content = [{ type: 'text', text: big }];
      const result = indexer._extractTextContent(content);
      expect(result).toContain('TEXT_TAIL_TOKEN');
    });

    it('extracts text from single text block object', () => {
      const content = { type: 'text', text: 'Single block text' };
      const result = indexer._extractTextContent(content);

      expect(result).toBe('Single block text');
    });

    it('returns empty string for null/undefined content', () => {
      expect(indexer._extractTextContent(null)).toBe('');
      expect(indexer._extractTextContent(undefined)).toBe('');
    });

    it('handles content blocks with missing text property', () => {
      const content = [
        { type: 'text' },
        { type: 'text', text: 'Has text' },
      ];
      const result = indexer._extractTextContent(content);

      expect(result).toContain('Has text');
    });
  });

  describe('_extractToolNames()', () => {
    it('extracts tool names from tool_use blocks', () => {
      const content = [
        { type: 'text', text: 'Some text' },
        { type: 'tool_use', id: 'tool1', name: 'Read', input: {} },
        { type: 'tool_use', id: 'tool2', name: 'Write', input: {} },
      ];
      const result = indexer._extractToolNames(content);

      expect(result).toContain('Read');
      expect(result).toContain('Write');
      expect(result.length).toBe(2);
    });

    it('handles single tool_use object', () => {
      const content = { type: 'tool_use', name: 'Bash', input: {} };
      const result = indexer._extractToolNames(content);

      expect(result).toContain('Bash');
    });

    it('returns empty array for content without tools', () => {
      const content = [
        { type: 'text', text: 'Just text' },
      ];
      const result = indexer._extractToolNames(content);

      expect(result).toEqual([]);
    });

    it('returns empty array for null content', () => {
      expect(indexer._extractToolNames(null)).toEqual([]);
      expect(indexer._extractToolNames(undefined)).toEqual([]);
    });

    it('skips tool_use blocks without name', () => {
      const content = [
        { type: 'tool_use', id: 'tool1', input: {} },
        { type: 'tool_use', id: 'tool2', name: 'ValidTool', input: {} },
      ];
      const result = indexer._extractToolNames(content);

      expect(result).toEqual(['ValidTool']);
    });
  });

  describe('_extractProjectFromPath()', () => {
    it('extracts encoded project path as fallback name', () => {
      const result = indexer._extractProjectFromPath(
        `${projectsDir}/-Users-test-project/conversation.jsonl`
      );

      // Should return encoded name without leading dash
      expect(result).toBe('Users-test-project');
    });

    it('handles paths without leading dash', () => {
      const result = indexer._extractProjectFromPath(
        `${projectsDir}/simple-project/conversation.jsonl`
      );

      expect(result).toBe('simple-project');
    });

    it('extracts first path component for paths outside projectsDir', () => {
      // When the path doesn't start with projectsDir, the function extracts
      // the first component after splitting. This is fallback behavior.
      const result = indexer._extractProjectFromPath('/some/random/path.jsonl');

      // Returns 'some' because path splits to ['some', 'random', 'path.jsonl']
      expect(result).toBe('some');
    });

    it('returns Unknown for empty path', () => {
      // Only returns Unknown when there are no path components
      const result = indexer._extractProjectFromPath('');

      expect(result).toBe('Unknown');
    });
  });

  describe('Subagent ID Generation - Regression Test', () => {
    it('generates unique IDs for subagents with same filename under different parents', async () => {
      // Setup two different parent conversations
      const parentA = 'parent-aaaa-1111';
      const parentB = 'parent-bbbb-2222';

      // Create subagent directories with same agent filename
      const subagentDirA = path.join(projectsDir, '-test-project', parentA, 'subagents');
      const subagentDirB = path.join(projectsDir, '-test-project', parentB, 'subagents');

      await fs.ensureDir(subagentDirA);
      await fs.ensureDir(subagentDirB);

      // Copy same fixture to both locations with same filename
      const sourceFixture = getConversationFixturePath('subagent.jsonl');
      await fs.copy(sourceFixture, path.join(subagentDirA, 'agent-1.jsonl'));
      await fs.copy(sourceFixture, path.join(subagentDirB, 'agent-1.jsonl'));

      // Run indexing
      const originalLog = console.log;
      const originalWarn = console.warn;
      console.log = () => {};
      console.warn = () => {};

      await indexer.runFullIndex();

      console.log = originalLog;
      console.warn = originalWarn;

      // Get all conversations including subagents
      const conversations = db.getConversations({ includeSubagents: true });
      const subagents = conversations.filter(c => c.isSubagent);

      // Should have 2 subagents with different IDs
      expect(subagents.length).toBe(2);

      const ids = subagents.map(s => s.id);
      expect(ids[0]).not.toBe(ids[1]);

      // IDs should include parent ID prefix
      expect(ids.some(id => id.includes(parentA))).toBe(true);
      expect(ids.some(id => id.includes(parentB))).toBe(true);
    });
  });

  describe('runFullIndex()', () => {
    it('indexes conversation files from projects directory', async () => {
      // Setup fixtures
      await setupFixturesInProjectsDir(projectsDir, {
        encodedPath: '-Users-testuser-my-project',
        fixtures: ['simple.jsonl', 'with-tools.jsonl'],
      });

      // Silence console output
      const originalLog = console.log;
      const originalWarn = console.warn;
      console.log = () => {};
      console.warn = () => {};

      const stats = await indexer.runFullIndex();

      console.log = originalLog;
      console.warn = originalWarn;

      expect(stats.filesScanned).toBe(2);
      expect(stats.filesIndexed).toBe(2);
      expect(stats.errors).toBe(0);

      // Verify conversations are in database
      const conversations = db.getConversations();
      expect(conversations.length).toBe(2);
    });

    it('extracts project name from cwd field', async () => {
      await setupFixturesInProjectsDir(projectsDir, {
        encodedPath: '-Users-testuser-encoded-path',
        fixtures: ['simple.jsonl'],
      });

      const originalLog = console.log;
      console.log = () => {};

      await indexer.runFullIndex();

      console.log = originalLog;

      const conversations = db.getConversations();
      // simple.jsonl has cwd: /Users/testuser/projects/my-awesome-project
      expect(conversations[0].project).toBe('my-awesome-project');
    });

    it('skips unchanged files on re-index', async () => {
      await setupFixturesInProjectsDir(projectsDir, {
        fixtures: ['simple.jsonl'],
      });

      const originalLog = console.log;
      console.log = () => {};

      // First index
      const stats1 = await indexer.runFullIndex();
      expect(stats1.filesIndexed).toBe(1);

      // Second index - should skip
      const stats2 = await indexer.runFullIndex();
      expect(stats2.filesSkipped).toBe(1);
      expect(stats2.filesIndexed).toBe(0);

      console.log = originalLog;
    });

    it('handles malformed JSONL files gracefully', async () => {
      await setupFixturesInProjectsDir(projectsDir, {
        fixtures: ['malformed.jsonl'],
      });

      const originalLog = console.log;
      const originalWarn = console.warn;
      console.log = () => {};
      console.warn = () => {};

      const stats = await indexer.runFullIndex();

      console.log = originalLog;
      console.warn = originalWarn;

      // Should still index the file (valid lines are processed)
      expect(stats.filesIndexed).toBe(1);
      expect(stats.errors).toBe(0);

      const conversations = db.getConversations();
      expect(conversations.length).toBe(1);
      expect(conversations[0].messageCount).toBeGreaterThan(0);
    });

    it('removes orphaned conversations even when file_index was cleared (migration case)', async () => {
      // Reproduces the Devin finding: after a content-version migration clears
      // file_index (to force reprocessing), a conversation whose file was
      // deleted before the upgrade must still be detected as gone and removed,
      // FTS row included — otherwise it lingers as a ghost search result.
      const [filePath] = await setupFixturesInProjectsDir(projectsDir, {
        fixtures: ['simple.jsonl'],
      });
      const origLog = console.log; console.log = () => {};

      await indexer.runFullIndex();
      const before = db.getConversations({ includeSubagents: true });
      expect(before.length).toBe(1);
      const orphanId = before[0].id;
      expect(db.searchConversationsWithSnippets('reverse', { includeSubagents: true }).length).toBe(1);

      // Simulate "deleted before upgrade" + "migration cleared file_index".
      await fs.remove(filePath);
      db.db.prepare('DELETE FROM file_index').run();

      await indexer.runFullIndex();
      console.log = origLog;

      // The orphan is gone from conversations AND from FTS.
      expect(db.getConversations({ includeSubagents: true }).length).toBe(0);
      expect(db.getConversation(orphanId)).toBeNull();
      expect(db.searchConversationsWithSnippets('reverse', { includeSubagents: true }).length).toBe(0);
    });

    it('removes deleted files from database', async () => {
      const [filePath] = await setupFixturesInProjectsDir(projectsDir, {
        fixtures: ['simple.jsonl'],
      });

      const originalLog = console.log;
      console.log = () => {};

      // First index
      await indexer.runFullIndex();

      // Delete the file
      await fs.remove(filePath);

      // Re-index
      const stats = await indexer.runFullIndex();

      console.log = originalLog;

      expect(stats.filesRemoved).toBe(1);

      const conversations = db.getConversations();
      expect(conversations.length).toBe(0);
    });
  });

  describe('indexSingleFile()', () => {
    it('indexes a single file', async () => {
      const [filePath] = await setupFixturesInProjectsDir(projectsDir, {
        fixtures: ['simple.jsonl'],
      });

      const result = await indexer.indexSingleFile(filePath);

      expect(result.success).toBe(true);

      const conversations = db.getConversations();
      expect(conversations.length).toBe(1);
    });

    it('returns error info for non-existent file', async () => {
      const originalWarn = console.warn;
      console.warn = () => {};

      const result = await indexer.indexSingleFile('/nonexistent/file.jsonl');

      console.warn = originalWarn;

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
