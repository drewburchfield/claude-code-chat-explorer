/**
 * Pipeline Integration Tests
 *
 * Tests for the full indexing pipeline:
 * JSONL file -> Indexer -> SQLite -> Searchable
 *
 * Verifies that the complete data flow works correctly.
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

const Indexer = require('../../src/analytics/data/Indexer');

describe('Pipeline Integration', () => {
  let db;
  let dbCleanup;
  let projectsDir;
  let claudeDir;
  let projectsCleanup;
  let indexer;

  // Silence console output for cleaner test output
  let originalLog;
  let originalWarn;

  beforeEach(async () => {
    originalLog = console.log;
    originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};

    const dbResult = await createTestDatabase();
    db = dbResult.db;
    dbCleanup = dbResult.cleanup;

    const projectsResult = await createTempProjectsDir();
    projectsDir = projectsResult.projectsDir;
    claudeDir = projectsResult.claudeDir;
    projectsCleanup = projectsResult.cleanup;

    indexer = new Indexer(db, claudeDir);
  });

  afterEach(async () => {
    console.log = originalLog;
    console.warn = originalWarn;

    await dbCleanup();
    await projectsCleanup();
  });

  describe('Full Indexing Pipeline', () => {
    it('indexes JSONL files and makes them searchable', async () => {
      // Setup: Create a JSONL file with specific content
      await setupFixturesInProjectsDir(projectsDir, {
        encodedPath: '-Users-testuser-unique-project',
        fixtures: ['simple.jsonl'],
      });

      // Action: Run the indexer
      await indexer.runFullIndex();

      // Verify: File is indexed and searchable
      const conversations = db.getConversations();
      expect(conversations.length).toBe(1);

      // Search for content from the fixture
      const results = db.searchConversationsWithSnippets('reverse a string');
      expect(results.length).toBe(1);
      expect(results[0].snippet).toBeDefined();
    });

    it('extracts correct metadata from JSONL files', async () => {
      await setupFixturesInProjectsDir(projectsDir, {
        encodedPath: '-Users-testuser-metadata-project',
        fixtures: ['with-tools.jsonl'],
      });

      await indexer.runFullIndex();

      const conversations = db.getConversations();
      const conv = conversations[0];

      // Verify metadata extraction
      expect(conv.messageCount).toBeGreaterThan(0);
      expect(conv.project).toBe('test-project'); // From cwd in fixture
      expect(conv.modelInfo.primaryModel).toBe('claude-sonnet-4-20250514');
      expect(conv.tokenUsage.total).toBeGreaterThan(0);
    });

    it('tracks tool usage from conversations', async () => {
      await setupFixturesInProjectsDir(projectsDir, {
        encodedPath: '-Users-testuser-tools-project',
        fixtures: ['with-tools.jsonl'],
      });

      await indexer.runFullIndex();

      const toolStats = db.getToolUsageStats();

      // with-tools.jsonl uses Read, Write, and Bash
      const toolNames = toolStats.map(t => t.tool_name);
      expect(toolNames).toContain('Read');
      expect(toolNames).toContain('Write');
      expect(toolNames).toContain('Bash');
    });

    it('handles multiple projects correctly', async () => {
      // Setup multiple projects
      await setupFixturesInProjectsDir(projectsDir, {
        encodedPath: '-Users-testuser-project-one',
        fixtures: ['simple.jsonl'],
      });

      await setupFixturesInProjectsDir(projectsDir, {
        encodedPath: '-Users-testuser-project-two',
        fixtures: ['with-tools.jsonl'],
      });

      await indexer.runFullIndex();

      const conversations = db.getConversations();
      expect(conversations.length).toBe(2);

      const projects = db.getProjects();
      // Projects extracted from cwd fields in fixtures
      expect(projects).toContain('my-awesome-project'); // from simple.jsonl
      expect(projects).toContain('test-project'); // from with-tools.jsonl
    });
  });

  describe('Subagent Pipeline', () => {
    it('indexes subagents with correct parent relationship', async () => {
      // Setup parent conversation
      const parentId = 'parent-abc-123';
      const projectDir = path.join(projectsDir, '-Users-testuser-subagent-project');
      await fs.ensureDir(projectDir);

      // Create parent file
      const parentContent = await fs.readFile(
        getConversationFixturePath('simple.jsonl'),
        'utf8'
      );
      await fs.writeFile(path.join(projectDir, `${parentId}.jsonl`), parentContent);

      // Create subagent
      await setupSubagentFixture(projectsDir, parentId, '-Users-testuser-subagent-project');

      await indexer.runFullIndex();

      // Verify relationships
      const allConvs = db.getConversations({ includeSubagents: true });
      expect(allConvs.length).toBe(2);

      const parent = allConvs.find(c => c.id === parentId);
      const subagent = allConvs.find(c => c.isSubagent);

      expect(parent).toBeDefined();
      expect(parent.isSubagent).toBe(false);

      expect(subagent).toBeDefined();
      expect(subagent.isSubagent).toBe(true);
      expect(subagent.parentId).toBe(parentId);
    });

    it('generates unique IDs for subagents - regression test', async () => {
      // This tests the fix for subagent ID collisions
      const projectDir = path.join(projectsDir, '-Users-testuser-collision-test');

      // Create two parents
      const parent1 = 'parent-111-aaa';
      const parent2 = 'parent-222-bbb';

      await fs.ensureDir(path.join(projectDir, parent1, 'subagents'));
      await fs.ensureDir(path.join(projectDir, parent2, 'subagents'));

      // Create subagents with SAME filename under different parents
      const subagentContent = await fs.readFile(
        getConversationFixturePath('subagent.jsonl'),
        'utf8'
      );

      await fs.writeFile(
        path.join(projectDir, parent1, 'subagents', 'agent-1.jsonl'),
        subagentContent
      );
      await fs.writeFile(
        path.join(projectDir, parent2, 'subagents', 'agent-1.jsonl'),
        subagentContent
      );

      await indexer.runFullIndex();

      const subagents = db.getConversations({ includeSubagents: true })
        .filter(c => c.isSubagent);

      expect(subagents.length).toBe(2);

      // IDs should be unique (parentId_agentId format)
      const ids = subagents.map(s => s.id);
      expect(ids[0]).not.toBe(ids[1]);

      // Both should contain the prefix from their parent
      expect(ids.some(id => id.includes(parent1))).toBe(true);
      expect(ids.some(id => id.includes(parent2))).toBe(true);
    });
  });

  describe('Incremental Indexing', () => {
    it('skips unchanged files on re-index', async () => {
      await setupFixturesInProjectsDir(projectsDir, {
        fixtures: ['simple.jsonl'],
      });

      // First index
      const stats1 = await indexer.runFullIndex();
      expect(stats1.filesIndexed).toBe(1);

      // Second index without changes
      const stats2 = await indexer.runFullIndex();
      expect(stats2.filesSkipped).toBe(1);
      expect(stats2.filesIndexed).toBe(0);
    });

    it('re-indexes modified files', async () => {
      const [filePath] = await setupFixturesInProjectsDir(projectsDir, {
        fixtures: ['simple.jsonl'],
      });

      // First index
      await indexer.runFullIndex();

      // Modify file (append a new line)
      const originalContent = await fs.readFile(filePath, 'utf8');
      const newLine = '{"type":"user","message":{"role":"user","content":"New message"},"timestamp":"2024-01-20T10:00:00Z"}';
      await fs.writeFile(filePath, originalContent + '\n' + newLine);

      // Touch file to update mtime
      const now = new Date();
      await fs.utimes(filePath, now, now);

      // Re-index
      const stats = await indexer.runFullIndex();
      expect(stats.filesIndexed).toBe(1);
    });

    it('removes deleted files from database', async () => {
      const [filePath] = await setupFixturesInProjectsDir(projectsDir, {
        fixtures: ['simple.jsonl'],
      });

      // Index
      await indexer.runFullIndex();
      expect(db.getConversations().length).toBe(1);

      // Delete file
      await fs.remove(filePath);

      // Re-index
      const stats = await indexer.runFullIndex();
      expect(stats.filesRemoved).toBe(1);
      expect(db.getConversations().length).toBe(0);
    });
  });

  describe('Project Name Resolution', () => {
    it('resolves encoded project names from cwd - regression test', async () => {
      const encodedPath = '-Users-testuser-projects-my-project';

      // Create two conversations in same encoded folder
      const projectDir = path.join(projectsDir, encodedPath);
      await fs.ensureDir(projectDir);

      // First file has cwd
      const withCwd = await fs.readFile(
        getConversationFixturePath('simple.jsonl'),
        'utf8'
      );
      await fs.writeFile(path.join(projectDir, 'with-cwd.jsonl'), withCwd);

      // Second file - create one without cwd
      const noCwdContent = `{"type":"user","message":{"role":"user","content":"No cwd here"},"timestamp":"2024-01-15T10:00:00Z"}
{"type":"assistant","message":{"role":"assistant","content":"Response"},"timestamp":"2024-01-15T10:00:01Z"}`;
      await fs.writeFile(path.join(projectDir, 'no-cwd.jsonl'), noCwdContent);

      await indexer.runFullIndex();

      // Both should have proper project names after resolution
      const conversations = db.getConversations();

      // At least one should have the proper project name from cwd
      const withProperName = conversations.find(c => c.project === 'my-awesome-project');
      expect(withProperName).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('continues indexing after encountering malformed files', async () => {
      await setupFixturesInProjectsDir(projectsDir, {
        fixtures: ['simple.jsonl', 'malformed.jsonl', 'with-tools.jsonl'],
      });

      const stats = await indexer.runFullIndex();

      // All files should be processed (malformed has some valid lines)
      expect(stats.filesIndexed).toBe(3);
      expect(stats.errors).toBe(0); // File-level errors

      const conversations = db.getConversations();
      expect(conversations.length).toBe(3);
    });

    it('handles empty projects directory', async () => {
      // projectsDir exists but is empty
      const stats = await indexer.runFullIndex();

      expect(stats.filesScanned).toBe(0);
      expect(stats.errors).toBe(0);
    });
  });

  describe('FTS5 Search Integration', () => {
    it('searches across multiple conversations', async () => {
      await setupFixturesInProjectsDir(projectsDir, {
        encodedPath: '-project-1',
        fixtures: ['simple.jsonl'],
      });

      await setupFixturesInProjectsDir(projectsDir, {
        encodedPath: '-project-2',
        fixtures: ['with-tools.jsonl'],
      });

      await indexer.runFullIndex();

      // Search for term that appears in both
      const results = db.searchConversationsWithSnippets('file');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('handles special characters in search - regression test', async () => {
      await setupFixturesInProjectsDir(projectsDir, {
        fixtures: ['simple.jsonl'],
      });

      await indexer.runFullIndex();

      // These should not throw errors
      expect(() => db.searchConversations('test:query')).not.toThrow();
      expect(() => db.searchConversations('(test AND query)')).not.toThrow();
      expect(() => db.searchConversations('file "path" here')).not.toThrow();
    });
  });
});
