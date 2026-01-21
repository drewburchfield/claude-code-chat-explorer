/**
 * DatabaseManager Unit Tests
 *
 * Tests for SQLite + FTS5 database operations including:
 * - Schema creation and migrations
 * - CRUD operations for conversations
 * - Full-text search functionality
 * - Subagent handling
 * - Project name resolution
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const {
  createTestDatabase,
  createMockConversation,
  createSearchableContent,
} = require('../helpers/test-db');

describe('DatabaseManager', () => {
  let db;
  let cleanup;

  beforeEach(async () => {
    const result = await createTestDatabase();
    db = result.db;
    cleanup = result.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('Schema Creation', () => {
    it('creates conversations table with correct columns', () => {
      const columns = db.db.prepare("PRAGMA table_info(conversations)").all();
      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('file_path');
      expect(columnNames).toContain('filename');
      expect(columnNames).toContain('project');
      expect(columnNames).toContain('message_count');
      expect(columnNames).toContain('tokens_total');
      expect(columnNames).toContain('is_subagent');
      expect(columnNames).toContain('parent_id');
    });

    it('creates FTS5 virtual table for full-text search', () => {
      const tables = db.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_fts'"
      ).get();

      expect(tables).toBeDefined();
      expect(tables.name).toBe('conversation_fts');
    });

    it('creates required indexes', () => {
      const indexes = db.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index'"
      ).all();
      const indexNames = indexes.map(i => i.name);

      expect(indexNames).toContain('idx_conversations_last_modified');
      expect(indexNames).toContain('idx_conversations_project');
      expect(indexNames).toContain('idx_conversations_tokens');
    });

    it('creates tool_usage table', () => {
      const columns = db.db.prepare("PRAGMA table_info(tool_usage)").all();
      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('conversation_id');
      expect(columnNames).toContain('tool_name');
      expect(columnNames).toContain('call_count');
    });
  });

  describe('_escapeFtsQuery()', () => {
    it('escapes special FTS5 characters', () => {
      expect(db._escapeFtsQuery('test:query')).toBe('test query');
      expect(db._escapeFtsQuery('test"quoted"')).toBe('test quoted');
      expect(db._escapeFtsQuery('test(parens)')).toBe('test parens');
      expect(db._escapeFtsQuery('test^caret')).toBe('test caret');
      expect(db._escapeFtsQuery('test*wildcard')).toBe('test wildcard');
    });

    it('removes boolean operators', () => {
      expect(db._escapeFtsQuery('test AND query')).toBe('test query');
      expect(db._escapeFtsQuery('test OR query')).toBe('test query');
      expect(db._escapeFtsQuery('test NOT query')).toBe('test query');
      expect(db._escapeFtsQuery('test NEAR query')).toBe('test query');
    });

    it('handles case-insensitive operators', () => {
      expect(db._escapeFtsQuery('test and query')).toBe('test query');
      expect(db._escapeFtsQuery('test or query')).toBe('test query');
    });

    it('normalizes whitespace', () => {
      expect(db._escapeFtsQuery('test   multiple   spaces')).toBe('test multiple spaces');
    });

    it('returns * for empty queries after escaping', () => {
      expect(db._escapeFtsQuery('')).toBe('*');
      expect(db._escapeFtsQuery('   ')).toBe('*');
      expect(db._escapeFtsQuery('AND OR NOT')).toBe('*');
    });

    it('handles complex mixed input', () => {
      const result = db._escapeFtsQuery('error:ENOENT AND (file NOT found)');
      expect(result).not.toContain(':');
      expect(result).not.toContain('(');
      expect(result).not.toContain(')');
      expect(result).not.toMatch(/\bAND\b/i);
      expect(result).not.toMatch(/\bNOT\b/i);
    });
  });

  describe('upsertConversation()', () => {
    it('inserts a new conversation', () => {
      const conv = createMockConversation({ id: 'test-insert-001' });
      const content = createSearchableContent('Hello world test content');

      db.upsertConversation(conv, content);

      const result = db.getConversation('test-insert-001');
      expect(result).toBeDefined();
      expect(result.id).toBe('test-insert-001');
      expect(result.project).toBe('test-project');
      expect(result.messageCount).toBe(10);
    });

    it('updates an existing conversation', () => {
      const conv = createMockConversation({ id: 'test-update-001', messageCount: 5 });
      db.upsertConversation(conv, 'initial content');

      // Update with new message count
      const updatedConv = createMockConversation({ id: 'test-update-001', messageCount: 15 });
      db.upsertConversation(updatedConv, 'updated content');

      const result = db.getConversation('test-update-001');
      expect(result.messageCount).toBe(15);
    });

    it('indexes content for FTS search', () => {
      const conv = createMockConversation({ id: 'test-fts-001' });
      db.upsertConversation(conv, 'unique searchable keyword xyzabc123');

      const results = db.searchConversations('xyzabc123');
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('test-fts-001');
    });

    it('stores tool usage data', () => {
      const conv = createMockConversation({
        id: 'test-tools-001',
        toolUsage: { total: 10, tools: { Read: 5, Write: 3, Bash: 2 } },
      });
      db.upsertConversation(conv, 'content with tools');

      const toolStats = db.getToolUsageStats();
      const readTool = toolStats.find(t => t.tool_name === 'Read');

      expect(readTool).toBeDefined();
      expect(readTool.total_calls).toBe(5);
    });

    it('handles subagent conversations', () => {
      const conv = createMockConversation({
        id: 'parent-001_agent-1',
        isSubagent: true,
        parentId: 'parent-001',
      });
      db.upsertConversation(conv, 'subagent content');

      const result = db.getConversation('parent-001_agent-1');
      expect(result.isSubagent).toBe(true);
      expect(result.parentId).toBe('parent-001');
    });
  });

  describe('getConversation() / getConversations()', () => {
    beforeEach(() => {
      // Insert test data
      for (let i = 1; i <= 5; i++) {
        const conv = createMockConversation({
          id: `conv-${i}`,
          project: i <= 3 ? 'project-a' : 'project-b',
          lastModified: new Date(Date.now() - i * 60000),
          tokenUsage: { total: i * 100, input: i * 60, output: i * 40 },
        });
        db.upsertConversation(conv, `Content for conversation ${i}`);
      }
    });

    it('retrieves a single conversation by ID', () => {
      const result = db.getConversation('conv-3');

      expect(result).toBeDefined();
      expect(result.id).toBe('conv-3');
    });

    it('returns null for non-existent conversation', () => {
      const result = db.getConversation('non-existent');

      expect(result).toBeNull();
    });

    it('retrieves all conversations with default options', () => {
      const results = db.getConversations();

      expect(results.length).toBe(5);
    });

    it('applies pagination correctly', () => {
      const page1 = db.getConversations({ limit: 2, offset: 0 });
      const page2 = db.getConversations({ limit: 2, offset: 2 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
      expect(page1[0].id).not.toBe(page2[0].id);
    });

    it('filters by project', () => {
      const results = db.getConversations({ project: 'project-a' });

      expect(results.length).toBe(3);
      results.forEach(conv => {
        expect(conv.project).toBe('project-a');
      });
    });

    it('sorts by specified field', () => {
      const results = db.getConversations({ sortBy: 'tokens_total', sortOrder: 'DESC' });

      expect(results[0].tokenUsage.total).toBeGreaterThanOrEqual(results[1].tokenUsage.total);
    });
  });

  describe('searchConversationsWithSnippets()', () => {
    beforeEach(() => {
      const conversations = [
        { id: 'search-1', content: 'JavaScript function to reverse a string' },
        { id: 'search-2', content: 'Python script for data analysis' },
        { id: 'search-3', content: 'JavaScript array methods and loops' },
        { id: 'search-4', content: 'Database query optimization techniques' },
      ];

      conversations.forEach(({ id, content }) => {
        const conv = createMockConversation({ id });
        db.upsertConversation(conv, content);
      });
    });

    it('finds conversations matching search term', () => {
      const results = db.searchConversationsWithSnippets('JavaScript');

      expect(results.length).toBe(2);
      const ids = results.map(r => r.id);
      expect(ids).toContain('search-1');
      expect(ids).toContain('search-3');
    });

    it('returns snippets with matched terms', () => {
      const results = db.searchConversationsWithSnippets('JavaScript');

      expect(results[0].snippet).toBeDefined();
      expect(results[0].searchTerm).toBe('JavaScript');
    });

    it('returns empty array for no matches', () => {
      const results = db.searchConversationsWithSnippets('nonexistentterm123');

      expect(results).toEqual([]);
    });

    it('handles empty query', () => {
      const results = db.searchConversationsWithSnippets('');

      expect(results).toEqual([]);
    });

    it('includes relevance scores', () => {
      const results = db.searchConversationsWithSnippets('JavaScript');

      expect(results[0]).toHaveProperty('relevance');
      expect(typeof results[0].relevance).toBe('number');
    });
  });

  describe('Subagent Filtering', () => {
    beforeEach(() => {
      // Insert parent conversation
      const parent = createMockConversation({
        id: 'parent-conv-001',
        isSubagent: false,
        parentId: null,
      });
      db.upsertConversation(parent, 'Parent conversation content');

      // Insert subagent conversations
      for (let i = 1; i <= 3; i++) {
        const subagent = createMockConversation({
          id: `parent-conv-001_agent-${i}`,
          isSubagent: true,
          parentId: 'parent-conv-001',
        });
        db.upsertConversation(subagent, `Subagent ${i} content`);
      }
    });

    it('excludes subagents by default', () => {
      const results = db.getConversations();

      expect(results.length).toBe(1);
      expect(results[0].id).toBe('parent-conv-001');
    });

    it('includes subagents when requested', () => {
      const results = db.getConversations({ includeSubagents: true });

      expect(results.length).toBe(4);
    });

    it('excludes subagents from search by default', () => {
      const results = db.searchConversations('content');

      expect(results.length).toBe(1);
    });

    it('includes subagents in search when requested', () => {
      const results = db.searchConversations('content', { includeSubagents: true });

      expect(results.length).toBe(4);
    });
  });

  describe('resolveEncodedProjectNames() - Regression Test', () => {
    it('resolves encoded names using sibling cwd values', () => {
      // Simulate a folder with encoded project names
      const encodedFolder = '-Users-testuser-projects-my-project';
      const fallbackName = 'Users-testuser-projects-my-project'; // Without leading dash
      const rootCwd = '/Users/testuser/projects/my-project';

      // Insert conversation with proper name (from cwd at project root)
      const withCwd = createMockConversation({
        id: 'conv-with-cwd',
        filePath: `/Users/testuser/.claude/projects/${encodedFolder}/conv-with-cwd.jsonl`,
        project: 'my-project', // Proper name extracted from cwd
        cwd: rootCwd,
      });
      db.upsertConversation(withCwd, 'Content with cwd');

      // Insert conversation with fallback name (no cwd)
      const withoutCwd = createMockConversation({
        id: 'conv-without-cwd',
        filePath: `/Users/testuser/.claude/projects/${encodedFolder}/conv-without-cwd.jsonl`,
        project: fallbackName, // Fallback encoded name
        cwd: null, // No cwd available
      });
      db.upsertConversation(withoutCwd, 'Content without cwd');

      // Run resolution
      const result = db.resolveEncodedProjectNames();

      expect(result.resolved).toBe(1);
      expect(result.folders).toBe(1);

      // Verify the fallback name was updated
      const resolved = db.getConversation('conv-without-cwd');
      expect(resolved.project).toBe('my-project');
    });

    it('normalizes subdirectory project names to root', () => {
      // This tests the cli-tool bug fix: subagents spawned from subdirectories
      // should be normalized to the parent project name
      const encodedFolder = '-Users-testuser-projects-my-project';
      const rootCwd = '/Users/testuser/projects/my-project';
      const subDirCwd = '/Users/testuser/projects/my-project/src/components';

      // Insert conversation from project root
      const fromRoot = createMockConversation({
        id: 'conv-from-root',
        filePath: `/Users/testuser/.claude/projects/${encodedFolder}/conv-from-root.jsonl`,
        project: 'my-project',
        cwd: rootCwd,
      });
      db.upsertConversation(fromRoot, 'Content from root');

      // Insert conversation from subdirectory (would get "components" as project)
      const fromSubdir = createMockConversation({
        id: 'conv-from-subdir',
        filePath: `/Users/testuser/.claude/projects/${encodedFolder}/conv-from-subdir.jsonl`,
        project: 'components', // Wrong - extracted from subdirectory
        cwd: subDirCwd,
      });
      db.upsertConversation(fromSubdir, 'Content from subdir');

      // Run resolution
      const result = db.resolveEncodedProjectNames();

      expect(result.resolved).toBe(1);
      expect(result.folders).toBe(1);

      // Verify subdirectory name was normalized to root
      const resolved = db.getConversation('conv-from-subdir');
      expect(resolved.project).toBe('my-project');
    });

    it('does not modify conversations with proper names', () => {
      const encodedFolder = '-Users-testuser-projects-proper-project';
      const rootCwd = '/Users/testuser/projects/proper-project';

      const conv = createMockConversation({
        id: 'conv-proper',
        filePath: `/Users/testuser/.claude/projects/${encodedFolder}/conv-proper.jsonl`,
        project: 'proper-project',
        cwd: rootCwd,
      });
      db.upsertConversation(conv, 'Proper content');

      const result = db.resolveEncodedProjectNames();

      expect(result.resolved).toBe(0);

      const unchanged = db.getConversation('conv-proper');
      expect(unchanged.project).toBe('proper-project');
    });
  });

  describe('_migrateSubagentColumns()', () => {
    it('adds is_subagent and parent_id columns if missing', () => {
      // Columns should already exist after initialization
      const columns = db.db.prepare("PRAGMA table_info(conversations)").all();
      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('is_subagent');
      expect(columnNames).toContain('parent_id');
    });

    it('creates indexes for subagent columns', () => {
      const indexes = db.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index'"
      ).all();
      const indexNames = indexes.map(i => i.name);

      expect(indexNames).toContain('idx_conversations_parent');
      expect(indexNames).toContain('idx_conversations_subagent');
    });
  });

  describe('removeConversation() / removeFile()', () => {
    it('removes conversation and related data', () => {
      const conv = createMockConversation({
        id: 'to-remove',
        toolUsage: { total: 2, tools: { Read: 2 } },
      });
      db.upsertConversation(conv, 'Content to remove');

      db.removeConversation('to-remove');

      expect(db.getConversation('to-remove')).toBeNull();

      // Verify FTS entry is removed
      const ftsResults = db.searchConversations('Content to remove');
      expect(ftsResults.length).toBe(0);
    });

    it('clears orphaned subagent references when parent is removed', () => {
      // Insert parent
      const parent = createMockConversation({
        id: 'parent-to-remove',
        filePath: '/test/parent-to-remove.jsonl',
      });
      db.upsertConversation(parent, 'Parent content');

      // Insert subagent referencing parent
      const subagent = createMockConversation({
        id: 'subagent-orphan',
        isSubagent: true,
        parentId: 'parent-to-remove',
      });
      db.upsertConversation(subagent, 'Subagent content');

      // Remove parent file
      db.removeFile('/test/parent-to-remove.jsonl');

      // Subagent should still exist but with null parent_id
      const orphan = db.getConversation('subagent-orphan');
      expect(orphan).toBeDefined();
      expect(orphan.parentId).toBeNull();
    });
  });

  describe('Summary and Statistics', () => {
    beforeEach(() => {
      for (let i = 1; i <= 3; i++) {
        const conv = createMockConversation({
          id: `stats-conv-${i}`,
          project: `project-${i}`,
          messageCount: i * 10,
          fileSize: i * 1000,
          tokenUsage: { total: i * 500, input: i * 300, output: i * 200 },
          lastModified: new Date(), // Recent
        });
        db.upsertConversation(conv, `Stats content ${i}`);
      }
    });

    it('returns correct summary statistics', () => {
      const summary = db.getSummary();

      expect(summary.totalConversations).toBe(3);
      expect(summary.totalMessages).toBe(60); // 10 + 20 + 30
      expect(summary.totalTokens).toBe(3000); // 500 + 1000 + 1500
      expect(summary.totalProjects).toBe(3);
    });

    it('counts active conversations in last 24 hours', () => {
      const summary = db.getSummary();

      expect(summary.activeToday).toBe(3);
    });

    it('returns tool usage statistics', () => {
      const stats = db.getToolUsageStats();

      expect(Array.isArray(stats)).toBe(true);
      // Each conversation has Read: 3, Write: 2 tools
      const readTool = stats.find(t => t.tool_name === 'Read');
      expect(readTool.total_calls).toBe(9); // 3 convs * 3 calls
      expect(readTool.conversations).toBe(3);
    });

    it('returns unique project list', () => {
      const projects = db.getProjects();

      expect(projects.length).toBe(3);
      expect(projects).toContain('project-1');
      expect(projects).toContain('project-2');
      expect(projects).toContain('project-3');
    });
  });

  describe('File Index Tracking', () => {
    it('tracks indexed files', () => {
      const conv = createMockConversation({
        id: 'tracked-file',
        filePath: '/test/tracked.jsonl',
      });
      db.upsertConversation(conv, 'Tracked content');

      const indexedPaths = db.getIndexedFilePaths();

      expect(indexedPaths.has('/test/tracked.jsonl')).toBe(true);
    });

    it('detects when file needs re-indexing', () => {
      const filePath = '/test/needs-index.jsonl';
      const lastModified = new Date();
      const mtime = lastModified.getTime();
      const size = 5000; // Match the default fileSize in createMockConversation

      // Not indexed yet
      expect(db.needsIndexing(filePath, mtime, size)).toBe(true);

      // Index it - pass matching lastModified and fileSize
      const conv = createMockConversation({
        id: 'needs-index',
        filePath,
        lastModified,
        fileSize: size,
      });
      db.upsertConversation(conv, 'Content');

      // Same mtime and size - no need to re-index
      expect(db.needsIndexing(filePath, mtime, size)).toBe(false);

      // Different mtime - needs re-indexing
      expect(db.needsIndexing(filePath, mtime + 1000, size)).toBe(true);

      // Different size - needs re-indexing
      expect(db.needsIndexing(filePath, mtime, size + 100)).toBe(true);
    });
  });

  describe('Database Operations', () => {
    it('closes database connection', () => {
      db.close();

      expect(db.db).toBeNull();
    });

    it('performs vacuum operation', () => {
      // Insert and remove data to create space for vacuum
      const conv = createMockConversation({ id: 'vacuum-test' });
      db.upsertConversation(conv, 'Vacuum content');
      db.removeConversation('vacuum-test');

      // Should not throw
      expect(() => db.vacuum()).not.toThrow();
    });
  });
});
