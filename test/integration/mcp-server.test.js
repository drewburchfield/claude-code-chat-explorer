/**
 * MCP server integration test. Drives the server in-process through a linked
 * transport with a real MCP Client, exercising tools (structured output +
 * resource links), the conversation resource, and error handling.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const path = require('path');
const fs = require('fs-extra');
const { createTestDatabase, createTempProjectsDir } = require('../helpers/test-db');
const Indexer = require('../../src/analytics/data/Indexer');
const SearchService = require('../../src/analytics/search/SearchService');
const { buildServer } = require('../../src/mcp/server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

describe('MCP server', () => {
  let db, dbCleanup, projectsDir, claudeDir, projectsCleanup, client, convId;

  beforeAll(async () => {
    ({ db, cleanup: dbCleanup } = await createTestDatabase());
    ({ projectsDir, claudeDir, cleanup: projectsCleanup } = await createTempProjectsDir());

    const dir = path.join(projectsDir, '-proj');
    await fs.ensureDir(dir);
    const lines = [
      { type: 'user', message: { role: 'user', content: 'please find MCPUNIQUETOKEN now' }, cwd: '/proj' },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4', content: 'done' } },
    ];
    await fs.writeFile(path.join(dir, 'conv.jsonl'), lines.map(l => JSON.stringify(l)).join('\n'));

    const indexer = new Indexer(db, claudeDir);
    const log = console.log; console.log = () => {};
    await indexer.runFullIndex();
    console.log = log;
    convId = db.getConversations({ includeSubagents: true })[0].id;

    const server = buildServer({ search: new SearchService(db), db });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  }, 30000);

  afterAll(async () => {
    try { if (client) await client.close(); } catch { /* ignore */ }
    await dbCleanup();
    await projectsCleanup();
  });

  it('lists the three search tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual(['list_facets', 'search_conversations', 'search_within_conversation']);
  });

  it('search_conversations returns structured output + a resource link', async () => {
    const res = await client.callTool({ name: 'search_conversations', arguments: { query: 'MCPUNIQUETOKEN' } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.total).toBeGreaterThanOrEqual(1);
    expect(res.structuredContent.results[0].conversationId).toBe(convId);
    const link = res.content.find(c => c.type === 'resource_link');
    expect(link).toBeDefined();
    expect(link.uri).toContain('claude-chat://conversation/');
    // The link's mimeType must match what the resource actually returns,
    // so a client doesn't mis-parse raw JSONL as a single JSON document.
    const read = await client.readResource({ uri: link.uri });
    expect(link.mimeType).toBe(read.contents[0].mimeType);
  });

  it('list_facets returns structured facets', async () => {
    const res = await client.callTool({ name: 'list_facets', arguments: {} });
    expect(res.structuredContent).toHaveProperty('projects');
    expect(res.structuredContent).toHaveProperty('models');
    expect(res.structuredContent.dateRange).toHaveProperty('min');
  });

  it('reads a conversation as a resource', async () => {
    const res = await client.readResource({ uri: `claude-chat://conversation/${encodeURIComponent(convId)}` });
    expect(res.contents[0].text).toContain('MCPUNIQUETOKEN');
  });

  it('search_within_conversation finds the matching line', async () => {
    const res = await client.callTool({
      name: 'search_within_conversation',
      arguments: { conversationId: convId, query: 'MCPUNIQUETOKEN' },
    });
    expect(res.structuredContent.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('returns a tool error for an unknown conversation', async () => {
    const res = await client.callTool({
      name: 'search_within_conversation',
      arguments: { conversationId: 'does-not-exist', query: 'x' },
    });
    expect(res.isError).toBe(true);
  });
});
