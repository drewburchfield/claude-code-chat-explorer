/**
 * BoundedMap unit tests.
 *
 * The Map wraps two long-runtime caches in chats-mobile that had no
 * upper bound. Pin: capacity enforcement, LRU eviction on overflow,
 * recency refresh on read, evictions metric, and the constructor
 * input contract.
 */
import { describe, it, expect } from 'vitest';
const BoundedMap = require('../../src/utils/BoundedMap.js');

describe('BoundedMap', () => {
  it('rejects non-positive or non-integer maxSize', () => {
    expect(() => new BoundedMap(0)).toThrow();
    expect(() => new BoundedMap(-5)).toThrow();
    expect(() => new BoundedMap(1.5)).toThrow();
    expect(() => new BoundedMap('200')).toThrow();
  });

  it('stores and retrieves like a Map until the cap', () => {
    const m = new BoundedMap(3);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    expect(m.size).toBe(3);
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(2);
    expect(m.get('c')).toBe(3);
    expect(m.evictions).toBe(0);
  });

  it('evicts the oldest entry once size exceeds maxSize', () => {
    const m = new BoundedMap(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3); // 'a' should be evicted
    expect(m.size).toBe(2);
    expect(m.has('a')).toBe(false);
    expect(m.has('b')).toBe(true);
    expect(m.has('c')).toBe(true);
    expect(m.evictions).toBe(1);
  });

  it('reads refresh recency so the read entry survives subsequent overflow', () => {
    const m = new BoundedMap(2);
    m.set('a', 1);
    m.set('b', 2);
    // Touch 'a' so it becomes the most-recently-used; 'b' is now oldest.
    expect(m.get('a')).toBe(1);
    m.set('c', 3); // expects 'b' evicted, not 'a'
    expect(m.has('a')).toBe(true);
    expect(m.has('b')).toBe(false);
    expect(m.has('c')).toBe(true);
  });

  it('updates in place when a key already exists, refreshing recency', () => {
    const m = new BoundedMap(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('a', 99); // update should not evict
    expect(m.size).toBe(2);
    expect(m.get('a')).toBe(99);
    expect(m.evictions).toBe(0);
    // Now 'b' is oldest because of the in-place update on 'a'.
    m.set('c', 3);
    expect(m.has('b')).toBe(false);
    expect(m.has('a')).toBe(true);
    expect(m.has('c')).toBe(true);
  });

  it('delete and clear behave like Map', () => {
    const m = new BoundedMap(3);
    m.set('a', 1);
    m.set('b', 2);
    expect(m.delete('a')).toBe(true);
    expect(m.delete('a')).toBe(false);
    m.clear();
    expect(m.size).toBe(0);
  });

  it('iterates in insertion-then-recency order, oldest first', () => {
    const m = new BoundedMap(3);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    m.get('a'); // 'a' moves to back
    expect(Array.from(m.keys())).toEqual(['b', 'c', 'a']);
  });

  it('caps memory under sustained churn without leaking', () => {
    const cap = 100;
    const m = new BoundedMap(cap);
    for (let i = 0; i < 10_000; i++) {
      m.set('k' + i, { i });
    }
    expect(m.size).toBe(cap);
    expect(m.evictions).toBe(9_900);
    // The most recent 100 keys must be the survivors.
    expect(m.has('k9999')).toBe(true);
    expect(m.has('k9900')).toBe(true);
    expect(m.has('k9899')).toBe(false);
  });
});
