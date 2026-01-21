/**
 * API Integration Tests
 *
 * Tests for the Express API endpoints including:
 * - GET /api/conversations
 * - POST /api/search
 * - GET /api/conversations/:id/messages
 *
 * These tests use supertest to make HTTP requests against a test server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const path = require('path');
const fs = require('fs-extra');
const express = require('express');
const request = require('supertest');
const {
  createTestDatabase,
  createMockConversation,
  createSearchableContent,
  createTempProjectsDir,
  setupFixturesInProjectsDir,
  getConversationFixturePath,
} = require('../helpers/test-db');

// We'll create a minimal API router for testing
// This simulates the relevant API endpoints from chats-mobile.js

describe('API Integration', () => {
  let app;
  let db;
  let dbCleanup;
  let projectsDir;
  let claudeDir;
  let projectsCleanup;

  beforeAll(async () => {
    // Create test database
    const dbResult = await createTestDatabase();
    db = dbResult.db;
    dbCleanup = dbResult.cleanup;

    // Create temp projects directory
    const projectsResult = await createTempProjectsDir();
    projectsDir = projectsResult.projectsDir;
    claudeDir = projectsResult.claudeDir;
    projectsCleanup = projectsResult.cleanup;

    // Setup fixtures
    await setupFixturesInProjectsDir(projectsDir, {
      encodedPath: '-Users-testuser-my-project',
      fixtures: ['simple.jsonl', 'with-tools.jsonl'],
    });

    // Create Express app with API routes
    app = express();
    app.use(express.json());

    // GET /api/conversations
    app.get('/api/conversations', (req, res) => {
      try {
        const {
          limit = 100,
          offset = 0,
          sortBy = 'last_modified',
          sortOrder = 'DESC',
          project,
          includeSubagents = false,
        } = req.query;

        const conversations = db.getConversations({
          limit: parseInt(limit),
          offset: parseInt(offset),
          sortBy,
          sortOrder,
          project,
          includeSubagents: includeSubagents === 'true',
        });

        res.json({
          conversations,
          total: db.getConversationCount(project),
          limit: parseInt(limit),
          offset: parseInt(offset),
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // POST /api/search
    app.post('/api/search', (req, res) => {
      try {
        const { query, limit = 50, offset = 0, includeSubagents = false } = req.body;

        if (!query || !query.trim()) {
          return res.json({ results: [], total: 0 });
        }

        const results = db.searchConversationsWithSnippets(query, {
          limit,
          offset,
          includeSubagents,
        });

        res.json({
          results,
          total: results.length,
          query,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/conversations/:id
    app.get('/api/conversations/:id', (req, res) => {
      try {
        const conversation = db.getConversation(req.params.id);

        if (!conversation) {
          return res.status(404).json({ error: 'Conversation not found' });
        }

        res.json(conversation);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/conversations/:id/messages
    app.get('/api/conversations/:id/messages', async (req, res) => {
      try {
        const conversation = db.getConversation(req.params.id);

        if (!conversation) {
          return res.status(404).json({ error: 'Conversation not found' });
        }

        // Read and parse the JSONL file
        const content = await fs.readFile(conversation.filePath, 'utf8');
        const lines = content.trim().split('\n').filter(line => line.trim());

        const messages = [];
        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            if (item.message && (item.type === 'assistant' || item.type === 'user')) {
              messages.push({
                id: item.message.id || item.uuid,
                role: item.message.role || item.type,
                content: item.message.content,
                timestamp: item.timestamp,
                model: item.message.model,
              });
            }
          } catch (parseErr) {
            // Skip invalid lines
          }
        }

        res.json({ messages, total: messages.length });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/projects
    app.get('/api/projects', (req, res) => {
      try {
        const projects = db.getProjects();
        res.json({ projects });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/tool-stats
    app.get('/api/tool-stats', (req, res) => {
      try {
        const stats = db.getToolUsageStats();
        res.json({ stats });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/summary
    app.get('/api/summary', (req, res) => {
      try {
        const summary = db.getSummary();
        res.json(summary);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  });

  afterAll(async () => {
    await dbCleanup();
    await projectsCleanup();
  });

  beforeEach(async () => {
    // Clear and repopulate test data
    // First, get all conversations and remove them
    const existing = db.getConversations({ limit: 1000, includeSubagents: true });
    for (const conv of existing) {
      db.removeConversation(conv.id);
    }

    // Insert test conversations
    const testConversations = [
      {
        id: 'test-conv-1',
        project: 'project-alpha',
        content: 'JavaScript programming tutorial about arrays',
      },
      {
        id: 'test-conv-2',
        project: 'project-alpha',
        content: 'Python data analysis with pandas',
      },
      {
        id: 'test-conv-3',
        project: 'project-beta',
        content: 'Database optimization and SQL queries',
      },
    ];

    for (const { id, project, content } of testConversations) {
      const conv = createMockConversation({
        id,
        project,
        filePath: path.join(projectsDir, '-Users-testuser-my-project', `${id}.jsonl`),
      });

      // Create the actual file for messages endpoint
      const fixtureContent = await fs.readFile(
        getConversationFixturePath('simple.jsonl'),
        'utf8'
      );
      await fs.writeFile(conv.filePath, fixtureContent);

      db.upsertConversation(conv, content);
    }
  });

  describe('GET /api/conversations', () => {
    it('returns all conversations', async () => {
      const res = await request(app).get('/api/conversations');

      expect(res.status).toBe(200);
      expect(res.body.conversations).toBeDefined();
      expect(res.body.conversations.length).toBe(3);
      expect(res.body.total).toBe(3);
    });

    it('applies pagination', async () => {
      const res = await request(app)
        .get('/api/conversations')
        .query({ limit: 2, offset: 0 });

      expect(res.status).toBe(200);
      expect(res.body.conversations.length).toBe(2);
      expect(res.body.limit).toBe(2);
      expect(res.body.offset).toBe(0);
    });

    it('filters by project', async () => {
      const res = await request(app)
        .get('/api/conversations')
        .query({ project: 'project-alpha' });

      expect(res.status).toBe(200);
      expect(res.body.conversations.length).toBe(2);
      res.body.conversations.forEach(conv => {
        expect(conv.project).toBe('project-alpha');
      });
    });

    it('excludes subagents by default', async () => {
      // Add a subagent
      const subagent = createMockConversation({
        id: 'subagent-test',
        isSubagent: true,
        parentId: 'test-conv-1',
      });
      db.upsertConversation(subagent, 'Subagent content');

      const res = await request(app).get('/api/conversations');

      expect(res.body.conversations.length).toBe(3);
      expect(res.body.conversations.find(c => c.id === 'subagent-test')).toBeUndefined();
    });

    it('includes subagents when requested', async () => {
      const subagent = createMockConversation({
        id: 'subagent-test-2',
        isSubagent: true,
        parentId: 'test-conv-1',
      });
      db.upsertConversation(subagent, 'Subagent content');

      const res = await request(app)
        .get('/api/conversations')
        .query({ includeSubagents: 'true' });

      expect(res.body.conversations.length).toBe(4);
    });
  });

  describe('POST /api/search', () => {
    it('searches conversations by content', async () => {
      const res = await request(app)
        .post('/api/search')
        .send({ query: 'JavaScript' });

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBe(1);
      expect(res.body.results[0].id).toBe('test-conv-1');
    });

    it('returns multiple results for matching query', async () => {
      const res = await request(app)
        .post('/api/search')
        .send({ query: 'data' }); // matches "data analysis" and potentially "Database"

      expect(res.status).toBe(200);
      expect(res.body.results.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty results for no matches', async () => {
      const res = await request(app)
        .post('/api/search')
        .send({ query: 'nonexistentterm12345' });

      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([]);
    });

    it('handles empty query', async () => {
      const res = await request(app)
        .post('/api/search')
        .send({ query: '' });

      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([]);
    });

    it('includes snippets in search results', async () => {
      const res = await request(app)
        .post('/api/search')
        .send({ query: 'JavaScript' });

      expect(res.body.results[0].snippet).toBeDefined();
      expect(res.body.results[0].searchTerm).toBe('JavaScript');
    });
  });

  describe('GET /api/conversations/:id', () => {
    it('returns conversation by ID', async () => {
      const res = await request(app).get('/api/conversations/test-conv-1');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('test-conv-1');
      expect(res.body.project).toBe('project-alpha');
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await request(app).get('/api/conversations/non-existent-id');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Conversation not found');
    });
  });

  describe('GET /api/conversations/:id/messages', () => {
    it('returns messages for a conversation', async () => {
      const res = await request(app).get('/api/conversations/test-conv-1/messages');

      expect(res.status).toBe(200);
      expect(res.body.messages).toBeDefined();
      expect(Array.isArray(res.body.messages)).toBe(true);
      expect(res.body.messages.length).toBeGreaterThan(0);
    });

    it('messages have correct structure', async () => {
      const res = await request(app).get('/api/conversations/test-conv-1/messages');

      const message = res.body.messages[0];
      expect(message).toHaveProperty('role');
      expect(message).toHaveProperty('content');
      expect(message).toHaveProperty('timestamp');
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await request(app).get('/api/conversations/non-existent/messages');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/projects', () => {
    it('returns unique project list', async () => {
      const res = await request(app).get('/api/projects');

      expect(res.status).toBe(200);
      expect(res.body.projects).toContain('project-alpha');
      expect(res.body.projects).toContain('project-beta');
    });
  });

  describe('GET /api/tool-stats', () => {
    it('returns tool usage statistics', async () => {
      const res = await request(app).get('/api/tool-stats');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.stats)).toBe(true);
    });
  });

  describe('GET /api/summary', () => {
    it('returns summary statistics', async () => {
      const res = await request(app).get('/api/summary');

      expect(res.status).toBe(200);
      expect(res.body.totalConversations).toBe(3);
      expect(res.body).toHaveProperty('totalTokens');
      expect(res.body).toHaveProperty('totalProjects');
    });
  });
});
