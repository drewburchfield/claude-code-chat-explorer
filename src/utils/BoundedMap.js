/**
 * BoundedMap - a Map with a hard size cap and LRU eviction.
 *
 * The chats-mobile process holds two Maps that grow with the number of
 * conversations the user has ever opened in a session - message snapshots
 * and message counts - and neither had any upper bound. A long-running
 * watcher process would therefore creep upward in RSS for the lifetime
 * of the process. BoundedMap caps the entry count and evicts the least
 * recently set/read entry when the cap is exceeded.
 *
 * Set or get both refresh recency; delete + clear behave like Map.
 */
class BoundedMap {
  constructor(maxSize = 200) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new TypeError('BoundedMap maxSize must be a positive integer');
    }
    this.maxSize = maxSize;
    // Map preserves insertion order; we move accessed keys to the back
    // by re-inserting on each get, so the oldest key is always at the
    // front for cheap eviction via the iterator.
    this._map = new Map();
    this._evictions = 0;
  }

  get size() {
    return this._map.size;
  }

  get evictions() {
    return this._evictions;
  }

  has(key) {
    return this._map.has(key);
  }

  get(key) {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key);
    // Refresh recency by reinserting at the back of the order.
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this._map.has(key)) {
      this._map.delete(key);
    }
    this._map.set(key, value);
    while (this._map.size > this.maxSize) {
      const oldestKey = this._map.keys().next().value;
      this._map.delete(oldestKey);
      this._evictions++;
    }
    return this;
  }

  delete(key) {
    return this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }

  keys() {
    return this._map.keys();
  }

  values() {
    return this._map.values();
  }

  entries() {
    return this._map.entries();
  }

  [Symbol.iterator]() {
    return this._map[Symbol.iterator]();
  }
}

module.exports = BoundedMap;
