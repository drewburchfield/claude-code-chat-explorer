/**
 * SearchService tests - the single search query path used by REST and MCP.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { createTestDatabase, createMockConversation } = require('../helpers/test-db');
const SearchService = require('../../src/analytics/search/SearchService');

describe('SearchService', () => {
  let db, cleanup, svc;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDatabase());
    svc = new SearchService(db);

    // Three conversations across two projects/models, one subagent.
    db.upsertConversation(
      createMockConversation({ id: 'c1', project: 'alpha', modelInfo: { primaryModel: 'opus' }, lastModified: new Date(1000) }),
      'the quick brown fox jumps'
    );
    db.upsertConversation(
      createMockConversation({ id: 'c2', project: 'beta', modelInfo: { primaryModel: 'sonnet' }, lastModified: new Date(2000) }),
      'the lazy dog sleeps quickly'
    );
    db.upsertConversation(
      createMockConversation({ id: 'c3', project: 'alpha', modelInfo: { primaryModel: 'opus' }, lastModified: new Date(3000), isSubagent: true, parentId: 'c1' }),
      'subagent reads the fox file'
    );
  });

  afterEach(async () => { await cleanup(); });

  it('returns FTS matches for a query (non-subagent by default)', () => {
    const { results, total, searchMode } = svc.search({ query: 'fox' });
    expect(searchMode).toBe('fts');
    expect(total).toBe(1);
    expect(results[0].id).toBe('c1');
  });

  it('includes subagents when asked', () => {
    const { total } = svc.search({ query: 'fox', includeSubagents: true });
    expect(total).toBe(2); // c1 + c3
  });

  it('restricts to subagents with subagentsOnly', () => {
    const { results } = svc.search({ query: 'fox', subagentsOnly: true });
    expect(results.map(r => r.id)).toEqual(['c3']);
  });

  it('filters by project', () => {
    const { total } = svc.search({ query: 'the', includeSubagents: true, project: 'beta' });
    expect(total).toBe(1);
  });

  it('filters by model', () => {
    const { results } = svc.search({ query: 'the', includeSubagents: true, model: 'sonnet' });
    expect(results.map(r => r.id)).toEqual(['c2']);
  });

  it('filters by date range', () => {
    const { results } = svc.search({ query: 'the', includeSubagents: true, dateFrom: 1500, dateTo: 2500 });
    expect(results.map(r => r.id)).toEqual(['c2']);
  });

  it('supports FTS OR operator', () => {
    const { total } = svc.search({ query: 'fox OR dog', includeSubagents: true });
    expect(total).toBe(3);
  });

  it('paginates', () => {
    const page1 = svc.search({ query: 'the', includeSubagents: true, limit: 1, offset: 0 });
    const page2 = svc.search({ query: 'the', includeSubagents: true, limit: 1, offset: 1 });
    expect(page1.total).toBe(3);
    expect(page1.results.length).toBe(1);
    expect(page1.results[0].id).not.toBe(page2.results[0].id);
  });

  it('browse mode (empty query) returns conversations', () => {
    const { searchMode, total } = svc.search({ query: '', includeSubagents: true });
    expect(searchMode).toBe('browse');
    expect(total).toBe(3);
  });

  it('exposes facets', () => {
    const f = svc.facets();
    expect(f.projects.sort()).toEqual(['alpha', 'beta']);
    expect(f.models.sort()).toEqual(['opus', 'sonnet']);
    expect(f.dateRange.min).toBe(1000);
    expect(f.dateRange.max).toBe(3000);
  });
});
