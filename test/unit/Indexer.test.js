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

  describe('_extractTextContent()', () => {
    it('extracts text from string content', () => {
      const content = 'Simple string content';
      const result = indexer._extractTextContent(content);

      expect(result).toBe('Simple string content');
    });

    it('extracts text from array of content blocks', () => {
      const content = [
        { type: 'text', text: 'First paragraph' },
        { type: 'tool_use', name: 'Read', input: {} },
        { type: 'text', text: 'Second paragraph' },
      ];
      const result = indexer._extractTextContent(content);

      expect(result).toContain('First paragraph');
      expect(result).toContain('Second paragraph');
      expect(result).not.toContain('tool_use');
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
