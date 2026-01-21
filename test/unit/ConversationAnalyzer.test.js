/**
 * ConversationAnalyzer Unit Tests
 *
 * Tests for conversation analysis including:
 * - Token usage calculation
 * - Model info extraction
 * - Tool usage statistics
 * - Message parsing and correlation
 * - Status squares generation
 */

import { describe, it, expect, beforeEach } from 'vitest';
const path = require('path');
const fs = require('fs-extra');
const { getConversationFixturePath } = require('../helpers/test-db');

// Import ConversationAnalyzer
const ConversationAnalyzer = require('../../src/analytics/core/ConversationAnalyzer');

describe('ConversationAnalyzer', () => {
  let analyzer;
  let tempClaudeDir;

  beforeEach(() => {
    tempClaudeDir = '/tmp/test-claude-dir';
    analyzer = new ConversationAnalyzer(tempClaudeDir, null);
  });

  describe('calculateRealTokenUsage()', () => {
    it('calculates total tokens from messages with usage data', () => {
      const messages = [
        { usage: { input_tokens: 100, output_tokens: 50 } },
        { usage: { input_tokens: 200, output_tokens: 100 } },
        { usage: { input_tokens: 150, output_tokens: 75 } },
      ];

      const result = analyzer.calculateRealTokenUsage(messages);

      expect(result.inputTokens).toBe(450);
      expect(result.outputTokens).toBe(225);
      expect(result.total).toBe(675);
      expect(result.messagesWithUsage).toBe(3);
    });

    it('handles cache tokens when present', () => {
      const messages = [
        {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
          },
        },
      ];

      const result = analyzer.calculateRealTokenUsage(messages);

      expect(result.cacheCreationTokens).toBe(20);
      expect(result.cacheReadTokens).toBe(30);
    });

    it('handles messages without usage data', () => {
      const messages = [
        { content: 'No usage data' },
        { usage: { input_tokens: 100, output_tokens: 50 } },
        { content: 'Also no usage' },
      ];

      const result = analyzer.calculateRealTokenUsage(messages);

      expect(result.messagesWithUsage).toBe(1);
      expect(result.totalMessages).toBe(3);
      expect(result.total).toBe(150);
    });

    it('returns zeros for empty message array', () => {
      const result = analyzer.calculateRealTokenUsage([]);

      expect(result.total).toBe(0);
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.messagesWithUsage).toBe(0);
    });
  });

  describe('extractModelInfo()', () => {
    it('extracts unique models from messages', () => {
      const messages = [
        { model: 'claude-sonnet-4-20250514' },
        { model: 'claude-sonnet-4-20250514' },
        { model: 'claude-opus-4-20250514' },
      ];

      const result = analyzer.extractModelInfo(messages);

      expect(result.models).toContain('claude-sonnet-4-20250514');
      expect(result.models).toContain('claude-opus-4-20250514');
      expect(result.models.length).toBe(2);
    });

    it('identifies primary model as the last used', () => {
      const messages = [
        { model: 'claude-sonnet-4-20250514' },
        { model: 'claude-opus-4-20250514' },
      ];

      const result = analyzer.extractModelInfo(messages);

      expect(result.primaryModel).toBe('claude-opus-4-20250514');
    });

    it('detects multiple models flag', () => {
      const singleModel = [{ model: 'claude-sonnet-4-20250514' }];
      const multiModel = [
        { model: 'claude-sonnet-4-20250514' },
        { model: 'claude-opus-4-20250514' },
      ];

      expect(analyzer.extractModelInfo(singleModel).hasMultipleModels).toBe(false);
      expect(analyzer.extractModelInfo(multiModel).hasMultipleModels).toBe(true);
    });

    it('extracts service tier information', () => {
      const messages = [
        { usage: { service_tier: 'standard' } },
        { usage: { service_tier: 'priority' } },
      ];

      const result = analyzer.extractModelInfo(messages);

      expect(result.serviceTiers).toContain('standard');
      expect(result.serviceTiers).toContain('priority');
      expect(result.currentServiceTier).toBe('priority');
    });

    it('handles messages without model info', () => {
      const messages = [
        { content: 'No model' },
        { model: 'claude-sonnet-4-20250514' },
      ];

      const result = analyzer.extractModelInfo(messages);

      expect(result.models.length).toBe(1);
      expect(result.primaryModel).toBe('claude-sonnet-4-20250514');
    });

    it('returns Unknown for empty messages', () => {
      const result = analyzer.extractModelInfo([]);

      expect(result.primaryModel).toBe('Unknown');
      expect(result.currentServiceTier).toBe('Unknown');
    });
  });

  describe('extractToolUsage()', () => {
    it('extracts tool usage from array content with tool_use blocks', () => {
      const messages = [
        {
          role: 'assistant',
          timestamp: '2024-01-15T10:00:00Z',
          content: [
            { type: 'text', text: 'I will read the file' },
            { type: 'tool_use', id: 'tool1', name: 'Read', input: {} },
          ],
        },
        {
          role: 'assistant',
          timestamp: '2024-01-15T10:01:00Z',
          content: [
            { type: 'tool_use', id: 'tool2', name: 'Read', input: {} },
            { type: 'tool_use', id: 'tool3', name: 'Write', input: {} },
          ],
        },
      ];

      const result = analyzer.extractToolUsage(messages);

      expect(result.toolStats['Read']).toBe(2);
      expect(result.toolStats['Write']).toBe(1);
      expect(result.totalToolCalls).toBe(3);
      expect(result.uniqueTools).toBe(2);
    });

    it('extracts tool usage from string content with [Tool:] markers', () => {
      const messages = [
        {
          role: 'assistant',
          timestamp: '2024-01-15T10:00:00Z',
          content: 'I used [Tool: Read] and then [Tool: Write]',
        },
      ];

      const result = analyzer.extractToolUsage(messages);

      expect(result.toolStats['Read']).toBe(1);
      expect(result.toolStats['Write']).toBe(1);
      expect(result.totalToolCalls).toBe(2);
    });

    it('builds tool timeline in chronological order', () => {
      const messages = [
        {
          role: 'assistant',
          timestamp: '2024-01-15T10:01:00Z',
          content: [{ type: 'tool_use', name: 'Second' }],
        },
        {
          role: 'assistant',
          timestamp: '2024-01-15T10:00:00Z',
          content: [{ type: 'tool_use', name: 'First' }],
        },
      ];

      const result = analyzer.extractToolUsage(messages);

      expect(result.toolTimeline.length).toBe(2);
      expect(result.toolTimeline[0].tool).toBe('First');
      expect(result.toolTimeline[1].tool).toBe('Second');
    });

    it('ignores user messages', () => {
      const messages = [
        {
          role: 'user',
          timestamp: '2024-01-15T10:00:00Z',
          content: [{ type: 'tool_use', name: 'ShouldIgnore' }],
        },
        {
          role: 'assistant',
          timestamp: '2024-01-15T10:01:00Z',
          content: [{ type: 'tool_use', name: 'Counted' }],
        },
      ];

      const result = analyzer.extractToolUsage(messages);

      expect(result.toolStats['ShouldIgnore']).toBeUndefined();
      expect(result.toolStats['Counted']).toBe(1);
    });

    it('returns empty stats for no tools used', () => {
      const messages = [
        { role: 'assistant', content: 'Just plain text response' },
      ];

      const result = analyzer.extractToolUsage(messages);

      expect(result.totalToolCalls).toBe(0);
      expect(result.uniqueTools).toBe(0);
      expect(Object.keys(result.toolStats).length).toBe(0);
    });
  });

  describe('parseAndCorrelateToolMessages()', () => {
    it('parses JSONL lines into message objects', () => {
      const lines = [
        '{"type":"user","message":{"role":"user","content":"Hello"},"timestamp":"2024-01-15T10:00:00Z"}',
        '{"type":"assistant","message":{"role":"assistant","content":"Hi there!"},"timestamp":"2024-01-15T10:00:01Z"}',
      ];

      const result = analyzer.parseAndCorrelateToolMessages(lines);

      expect(result.length).toBe(2);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('assistant');
    });

    it('correlates tool_result with tool_use', () => {
      const lines = [
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool123","name":"Read","input":{}}]},"timestamp":"2024-01-15T10:00:00Z"}',
        '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool123","content":"File contents here"}]},"timestamp":"2024-01-15T10:00:01Z"}',
      ];

      const result = analyzer.parseAndCorrelateToolMessages(lines);

      // tool_result should be attached to tool_use, not a separate message
      expect(result.length).toBe(1);
      expect(result[0].toolResults).toBeDefined();
      expect(result[0].toolResults.length).toBe(1);
      expect(result[0].toolResults[0].content).toBe('File contents here');
    });

    it('handles invalid JSON lines gracefully', () => {
      const lines = [
        '{"type":"user","message":{"role":"user","content":"Valid"},"timestamp":"2024-01-15T10:00:00Z"}',
        'not valid json at all',
        '{"type":"assistant","message":{"role":"assistant","content":"Also valid"},"timestamp":"2024-01-15T10:00:01Z"}',
      ];

      const result = analyzer.parseAndCorrelateToolMessages(lines);

      expect(result.length).toBe(2);
    });

    it('preserves compact summary flag', () => {
      const lines = [
        '{"type":"assistant","message":{"role":"assistant","content":"Summary"},"timestamp":"2024-01-15T10:00:00Z","isCompactSummary":true}',
      ];

      const result = analyzer.parseAndCorrelateToolMessages(lines);

      expect(result[0].isCompactSummary).toBe(true);
    });
  });

  describe('generateStatusSquares()', () => {
    it('generates status squares for messages', () => {
      const messages = [
        { role: 'user', timestamp: new Date('2024-01-15T10:00:00Z'), content: 'Question' },
        { role: 'assistant', timestamp: new Date('2024-01-15T10:00:01Z'), content: 'Answer' },
      ];

      const result = analyzer.generateStatusSquares(messages);

      expect(result.length).toBe(2);
      expect(result[0].type).toBe('pending'); // user input
      expect(result[1].type).toBe('success'); // normal assistant
    });

    it('identifies tool usage status', () => {
      const messages = [
        {
          role: 'assistant',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          content: [{ type: 'tool_use', name: 'Read' }],
        },
      ];

      const result = analyzer.generateStatusSquares(messages);

      expect(result[0].type).toBe('tool');
    });

    it('identifies error status', () => {
      const messages = [
        {
          role: 'assistant',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          content: 'There was an error processing your request',
        },
      ];

      const result = analyzer.generateStatusSquares(messages);

      expect(result[0].type).toBe('error');
    });

    it('limits to last 10 messages', () => {
      const messages = Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        timestamp: new Date(Date.now() + i * 1000),
        content: `Message ${i}`,
      }));

      const result = analyzer.generateStatusSquares(messages);

      expect(result.length).toBe(10);
    });

    it('generates tooltips with message numbers', () => {
      const messages = [
        { role: 'user', timestamp: new Date(), content: 'Question' },
      ];

      const result = analyzer.generateStatusSquares(messages);

      expect(result[0].tooltip).toContain('Message #1');
    });

    it('returns empty array for no messages', () => {
      expect(analyzer.generateStatusSquares([])).toEqual([]);
      expect(analyzer.generateStatusSquares(null)).toEqual([]);
    });
  });

  describe('estimateTokens()', () => {
    it('estimates tokens based on character count', () => {
      const text = 'This is a test string with some content.';
      const result = analyzer.estimateTokens(text);

      // Roughly 4 chars per token
      expect(result).toBe(Math.ceil(text.length / 4));
    });

    it('handles empty string', () => {
      expect(analyzer.estimateTokens('')).toBe(0);
    });
  });

  describe('formatBytes()', () => {
    it('formats bytes correctly', () => {
      expect(analyzer.formatBytes(0)).toBe('0 Bytes');
      expect(analyzer.formatBytes(500)).toBe('500 Bytes');
      expect(analyzer.formatBytes(1024)).toBe('1 KB');
      expect(analyzer.formatBytes(1536)).toBe('1.5 KB');
      expect(analyzer.formatBytes(1048576)).toBe('1 MB');
      expect(analyzer.formatBytes(1073741824)).toBe('1 GB');
    });
  });

  describe('determineProjectStatus()', () => {
    it('returns active for recent activity (< 1 hour)', () => {
      const recentTime = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
      expect(analyzer.determineProjectStatus(recentTime)).toBe('active');
    });

    it('returns recent for activity within 24 hours', () => {
      const dayAgoTime = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12 hours ago
      expect(analyzer.determineProjectStatus(dayAgoTime)).toBe('recent');
    });

    it('returns inactive for activity > 24 hours ago', () => {
      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000); // 2 days ago
      expect(analyzer.determineProjectStatus(oldTime)).toBe('inactive');
    });
  });

  describe('Data Accessors', () => {
    it('returns conversations from getConversations()', () => {
      analyzer.data.conversations = [{ id: 'test' }];
      expect(analyzer.getConversations()).toEqual([{ id: 'test' }]);
    });

    it('returns projects from getActiveProjects()', () => {
      analyzer.data.activeProjects = [{ name: 'project' }];
      expect(analyzer.getActiveProjects()).toEqual([{ name: 'project' }]);
    });

    it('returns summary from getSummary()', () => {
      analyzer.data.summary = { total: 10 };
      expect(analyzer.getSummary()).toEqual({ total: 10 });
    });

    it('allows setting conversations', () => {
      analyzer.setConversations([{ id: 'new' }]);
      expect(analyzer.data.conversations).toEqual([{ id: 'new' }]);
    });

    it('allows setting orphan processes', () => {
      analyzer.setOrphanProcesses([{ pid: 123 }]);
      expect(analyzer.data.orphanProcesses).toEqual([{ pid: 123 }]);
    });
  });
});
