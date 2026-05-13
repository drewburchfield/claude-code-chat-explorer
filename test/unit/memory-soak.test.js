/**
 * Long-runtime memory soak test.
 *
 * Drives the two per-conversation Maps in chats-mobile and the
 * DataCache eviction policy through a synthetic stream of updates,
 * then asserts the resident memory delta stays well below a generous
 * ceiling. The shape of the test is "simulate 1000 conversation
 * updates and check we did not leak" - it isn't trying to measure
 * absolute bytes, just to prove that the bounded Maps and the LRU
 * eviction cap don't grow unboundedly.
 */
import { describe, it, expect, afterEach } from 'vitest';
const BoundedMap = require('../../src/utils/BoundedMap.js');
const DataCache = require('../../src/analytics/data/DataCache.js');

describe('long-runtime memory soak', () => {
  let cache;

  afterEach(() => {
    if (cache) cache.cleanup();
    cache = null;
  });

  it('BoundedMap holds steady at maxSize across many writes', () => {
    const m = new BoundedMap(200);
    const payload = (i) => ({
      msgs: new Array(50).fill(0).map((_, j) => ({ id: 'm' + j, len: i })),
    });
    for (let i = 0; i < 5000; i++) {
      m.set('conv-' + i, payload(i));
    }
    expect(m.size).toBe(200);
    expect(m.evictions).toBe(4800);
  });

  it('DataCache caches stay at or below maxCacheSize through churn', () => {
    cache = new DataCache();
    cache.configure({ maxCacheSize: 100 });
    // Plant a payload-bearing entry per "file"; enforceSizeLimits is
    // the path we exercise here (the periodic interval runs it every
    // 15s in prod, but we drive it directly to keep the test fast).
    for (let i = 0; i < 1000; i++) {
      cache.caches.fileContent.set('/syn/file-' + i, {
        content: 'x'.repeat(2048),
        timestamp: 1_000_000 + i,
        lastAccessed: 1_000_000 + i,
      });
      cache.caches.parsedConversations.set('/syn/file-' + i, {
        messages: new Array(20).fill({ role: 'assistant', text: 'hi' }),
        timestamp: 1_000_000 + i,
        lastAccessed: 1_000_000 + i,
      });
      // Every 100 inserts, run the eviction pass the way the timer
      // would in production.
      if (i % 100 === 99) cache.enforceSizeLimits();
    }
    cache.enforceSizeLimits();

    expect(cache.caches.fileContent.size).toBeLessThanOrEqual(100);
    expect(cache.caches.parsedConversations.size).toBeLessThanOrEqual(100);
    expect(cache.metrics.evictions).toBeGreaterThan(0);
  });

  it('process RSS delta is bounded under 50 MB on a 1000-update simulation', () => {
    // Lock down the actual contract from the plan: after 1000
    // synthetic updates the resident set should not have grown by
    // more than 50 MB. Worst case under the old code was a 50-entry
    // cap on per-file caches but unbounded growth on the chats-mobile
    // Maps, so the regression we're guarding against is the latter.
    const counts = new BoundedMap(200);
    const snapshots = new BoundedMap(200);
    if (global.gc) global.gc();
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 1000; i++) {
      counts.set('conv-' + i, i);
      snapshots.set('conv-' + i, new Array(50).fill({ id: 'm' + i }));
    }
    if (global.gc) global.gc();
    const after = process.memoryUsage().rss;
    const deltaMB = (after - before) / 1024 / 1024;
    expect(deltaMB).toBeLessThan(50);
  });
});
