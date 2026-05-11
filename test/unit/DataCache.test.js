/**
 * DataCache unit tests
 *
 * Cover the cache lifecycle primitives that the ingest pipeline depends
 * on: invalidate-single-file, invalidate-all, configure, stats, and the
 * periodic eviction. Not aimed at exhaustive coverage of every per-cache
 * getter (those are exercised end-to-end in the integration tests), just
 * the invariants we rely on elsewhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const DataCache = require('../../src/analytics/data/DataCache.js');

describe('DataCache', () => {
  let cache;

  beforeEach(() => {
    cache = new DataCache();
  });

  afterEach(() => {
    // The constructor spawns a 15s cleanup interval; close it so vitest
    // can exit cleanly between tests.
    cache.cleanup();
  });

  it('starts empty with zeroed metrics', () => {
    const stats = cache.getStats();
    expect(stats.cacheSize.fileContent).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  it('invalidateFile removes per-file entries across all caches', () => {
    // Plant fake entries directly so we can drive the behaviour without
    // touching disk.
    const filepath = '/tmp/fake.jsonl';
    cache.caches.fileContent.set(filepath, { content: 'x', mtime: 1 });
    cache.caches.parsedConversations.set(filepath, { data: [], mtime: 1 });
    cache.caches.tokenUsage.set(filepath, { data: {}, mtime: 1 });
    cache.caches.modelInfo.set(filepath, { data: {}, mtime: 1 });
    cache.caches.fileStats.set(filepath, { stats: {}, timestamp: Date.now() });

    cache.invalidateFile(filepath);

    expect(cache.caches.fileContent.has(filepath)).toBe(false);
    expect(cache.caches.parsedConversations.has(filepath)).toBe(false);
    expect(cache.caches.tokenUsage.has(filepath)).toBe(false);
    expect(cache.caches.modelInfo.has(filepath)).toBe(false);
    expect(cache.caches.fileStats.has(filepath)).toBe(false);
    expect(cache.metrics.filesInvalidated).toBe(1);
  });

  it('invalidateFiles invalidates a batch', () => {
    cache.caches.fileContent.set('/a', { content: '', mtime: 1 });
    cache.caches.fileContent.set('/b', { content: '', mtime: 1 });
    cache.invalidateFiles(['/a', '/b']);
    expect(cache.caches.fileContent.size).toBe(0);
    expect(cache.metrics.filesInvalidated).toBe(2);
  });

  it('invalidateAll clears every per-file cache and computation', () => {
    cache.caches.fileContent.set('/a', { content: 'x', mtime: 1 });
    cache.caches.parsedConversations.set('/b', { data: [], mtime: 1 });
    cache.caches.toolUsage.set('/c', { data: {}, mtime: 1 });
    cache.caches.sessions = { data: ['session'], timestamp: 1, dependencies: new Set(['/a']), dependencyTimestamps: new Map() };

    cache.invalidateAll();

    expect(cache.caches.fileContent.size).toBe(0);
    expect(cache.caches.parsedConversations.size).toBe(0);
    expect(cache.caches.toolUsage.size).toBe(0);
    expect(cache.caches.sessions.data).toBeNull();
    expect(cache.metrics.invalidations).toBeGreaterThanOrEqual(1);
    expect(cache.metrics.filesInvalidated).toBe(3);
  });

  it('invalidateComputations only resets aggregate slots', () => {
    cache.caches.fileContent.set('/a', { content: 'x', mtime: 1 });
    cache.caches.sessions = { data: ['session'], timestamp: 1, dependencies: new Set(), dependencyTimestamps: new Map() };
    cache.caches.summary = { data: { x: 1 }, timestamp: 1, dependencies: new Set(), dependencyTimestamps: new Map() };

    cache.invalidateComputations();

    expect(cache.caches.fileContent.has('/a')).toBe(true);
    expect(cache.caches.sessions.data).toBeNull();
    expect(cache.caches.summary.data).toBeNull();
  });

  it('clearAll wipes everything including metrics', () => {
    cache.caches.fileContent.set('/a', { content: 'x', mtime: 1 });
    cache.metrics.hits = 5;
    cache.metrics.misses = 7;

    cache.clearAll();

    expect(cache.caches.fileContent.size).toBe(0);
    expect(cache.metrics.hits).toBe(0);
    expect(cache.metrics.misses).toBe(0);
  });

  it('configure merges settings without throwing', () => {
    cache.configure({ fileContentTTL: 1000, maxCacheSize: 200 });
    expect(cache.config.fileContentTTL).toBe(1000);
    expect(cache.config.maxCacheSize).toBe(200);
  });

  it('getStats returns the metrics snapshot the dashboard consumes', () => {
    cache.metrics.hits = 3;
    cache.metrics.misses = 1;
    const stats = cache.getStats();
    expect(stats.hits).toBe(3);
    expect(stats.misses).toBe(1);
    expect(typeof stats.cacheSize).toBe('object');
    expect(typeof stats.hitRate).toBe('string');
  });

  it('needsWarming returns true on a fresh cache', () => {
    expect(cache.needsWarming()).toBe(true);
  });

  it('logStats does not throw on a fresh cache', () => {
    expect(() => cache.logStats()).not.toThrow();
  });

  it('invalidateAll preserves per-slot config fields (e.g. processes.ttl)', () => {
    // The processes slot owns a `ttl` field that does not exist on the
    // computation slots; a sloppy reset that overwrites the whole object
    // shape would erase it. We exercise the slot twice to catch any
    // first-call-only happy path.
    cache.caches.processes.data = { foo: 1 };
    cache.caches.processes.timestamp = 999;

    cache.invalidateAll();
    expect(cache.caches.processes.data).toBeNull();
    expect(cache.caches.processes.timestamp).toBe(0);
    expect(cache.caches.processes.ttl).toBe(500);
    expect(cache.caches.processes).not.toHaveProperty('dependencies');

    cache.invalidateAll();
    expect(cache.caches.processes.ttl).toBe(500);
  });

  it('invalidateAll accumulates metrics monotonically across calls', () => {
    cache.caches.fileContent.set('/a', { content: 'x', mtime: 1 });
    cache.invalidateAll();
    cache.caches.fileContent.set('/b', { content: 'x', mtime: 1 });
    cache.caches.fileContent.set('/c', { content: 'x', mtime: 1 });
    cache.invalidateAll();
    expect(cache.metrics.invalidations).toBe(2);
    expect(cache.metrics.filesInvalidated).toBe(3);
  });
});
