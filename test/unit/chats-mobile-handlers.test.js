/**
 * Unit tests for the per-file index handlers on ChatsMobile.
 *
 * These pin down two contracts the ingest pipeline depends on:
 *   1. handleFileChange re-throws indexer failures so the FileWatcher's
 *      catch can increment dataRefreshErrors. Swallowing them here would
 *      let /api/metrics report zero failures while the DB stays stale.
 *   2. Concurrent calls for the same file path coalesce so a burst of
 *      chokidar events does not stack redundant indexer work.
 *
 * We invoke the methods via the class prototype with a stub `this` so the
 * test doesn't have to stand up an HTTP server or a real SQLite backend.
 */
import { describe, it, expect, vi } from 'vitest';
const { ChatsMobile } = require('../../src/chats-mobile.js');

function makeStub(overrides = {}) {
  return {
    useDatabaseBackend: true,
    databaseBackend: {
      isInitialized: true,
      indexFile: vi.fn().mockResolvedValue(undefined),
      runIndex: vi.fn().mockResolvedValue(undefined),
    },
    handleDataRefresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ChatsMobile.handleFileChange', () => {
  it('indexes the file and triggers a debounced data refresh on success', async () => {
    const stub = makeStub();
    await ChatsMobile.prototype.handleFileChange.call(stub, '/tmp/a.jsonl');
    expect(stub.databaseBackend.indexFile).toHaveBeenCalledWith('/tmp/a.jsonl');
    expect(stub.handleDataRefresh).toHaveBeenCalled();
  });

  it('re-throws indexer errors so the watcher catch records the failure', async () => {
    const stub = makeStub({
      databaseBackend: {
        isInitialized: true,
        indexFile: vi.fn().mockRejectedValue(new Error('SQLITE_BUSY: database is locked')),
      },
    });
    await expect(
      ChatsMobile.prototype.handleFileChange.call(stub, '/tmp/a.jsonl')
    ).rejects.toThrow(/SQLITE_BUSY/);
    // The debounced refresh is skipped when indexing failed; the watcher's
    // own catch will mark the metric and skip its conversation-change ping.
    expect(stub.handleDataRefresh).not.toHaveBeenCalled();
  });

  it('still calls handleDataRefresh when the DB backend is not initialised', async () => {
    const stub = makeStub({ useDatabaseBackend: false });
    await ChatsMobile.prototype.handleFileChange.call(stub, '/tmp/a.jsonl');
    expect(stub.handleDataRefresh).toHaveBeenCalled();
  });

  it('coalesces concurrent calls for the same file path', async () => {
    // Simulate an indexer that completes on the next microtask tick.
    let resolveIndex;
    const stub = makeStub({
      databaseBackend: {
        isInitialized: true,
        indexFile: vi.fn(() => new Promise(r => { resolveIndex = r; })),
      },
    });
    const a = ChatsMobile.prototype.handleFileChange.call(stub, '/tmp/a.jsonl');
    const b = ChatsMobile.prototype.handleFileChange.call(stub, '/tmp/a.jsonl');
    resolveIndex();
    await Promise.all([a, b]);
    expect(stub.databaseBackend.indexFile).toHaveBeenCalledTimes(1);
  });
});

describe('ChatsMobile.handleFullReindex', () => {
  it('runs the indexer when DB backend is available', async () => {
    const stub = makeStub();
    await ChatsMobile.prototype.handleFullReindex.call(stub);
    expect(stub.databaseBackend.runIndex).toHaveBeenCalled();
  });

  it('re-throws so the periodic fallback catch records the failure', async () => {
    const stub = makeStub({
      databaseBackend: {
        isInitialized: true,
        runIndex: vi.fn().mockRejectedValue(new Error('disk full')),
      },
    });
    await expect(
      ChatsMobile.prototype.handleFullReindex.call(stub)
    ).rejects.toThrow(/disk full/);
  });

  it('coalesces overlapping calls so a long re-index is not invoked twice', async () => {
    let resolveRun;
    const stub = makeStub({
      databaseBackend: {
        isInitialized: true,
        runIndex: vi.fn(() => new Promise(r => { resolveRun = r; })),
      },
    });
    const a = ChatsMobile.prototype.handleFullReindex.call(stub);
    const b = ChatsMobile.prototype.handleFullReindex.call(stub);
    resolveRun();
    await Promise.all([a, b]);
    expect(stub.databaseBackend.runIndex).toHaveBeenCalledTimes(1);
  });
});

describe('ChatsMobile.handleConversationChange snapshot-eviction handling', () => {
  // Regression test: BoundedMap caps the working set of diff
  // snapshots, but the watcher's diff path used a `|| 0` fallback
  // when the snapshot was missing. For users with more conversations
  // than the cap, an evicted entry's first change event would look
  // like "all N messages are new" and would fan that out over the
  // websocket. The fix tracks an unbounded ever-seen Set so the
  // diff path can distinguish "evicted from cache" from "genuinely
  // new conversation" and skip the bogus broadcast.
  const BoundedMap = require('../../src/utils/BoundedMap.js');

  function diffStub({ everSeen = new Set(), counts = new BoundedMap(2), snapshots = new BoundedMap(2), parsed }) {
    const broadcast = vi.fn();
    return {
      stub: {
        log: () => {},
        conversationMessageCounts: counts,
        conversationMessageSnapshots: snapshots,
        conversationIdsEverSeen: everSeen,
        webSocketServer: { broadcast },
        data: { conversations: [{ id: 'c1', filePath: '/tmp/c1.jsonl' }] },
        conversationAnalyzer: {
          getParsedConversation: vi.fn().mockResolvedValue(parsed),
        },
        generateMessageSnapshot: (m) => JSON.stringify(m),
      },
      broadcast,
    };
  }

  it('does not broadcast on the first event after the snapshot was evicted', async () => {
    const everSeen = new Set(['c1']);
    const { stub, broadcast } = diffStub({
      everSeen,
      // counts and snapshots are empty -> simulating cache eviction
      parsed: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    });
    await ChatsMobile.prototype.handleConversationChange.call(stub, 'c1');
    expect(broadcast).not.toHaveBeenCalled();
    // After re-seed, the conversation is back in the cache.
    expect(stub.conversationMessageCounts.has('c1')).toBe(true);
    expect(stub.conversationMessageCounts.get('c1')).toBe(2);
  });

  it('still broadcasts on a genuinely-new conversation', async () => {
    const { stub, broadcast } = diffStub({
      // everSeen Set is empty -> this conversation is brand new.
      parsed: [
        { role: 'user', content: 'hello' },
      ],
    });
    await ChatsMobile.prototype.handleConversationChange.call(stub, 'c1');
    expect(broadcast).toHaveBeenCalled();
  });

  it('broadcasts only the delta on a normal in-cache change', async () => {
    const counts = new BoundedMap(2);
    const snapshots = new BoundedMap(2);
    counts.set('c1', 1);
    snapshots.set('c1', [JSON.stringify({ role: 'user', content: 'hello' })]);
    const { stub, broadcast } = diffStub({
      everSeen: new Set(['c1']),
      counts,
      snapshots,
      parsed: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    });
    await ChatsMobile.prototype.handleConversationChange.call(stub, 'c1');
    // One delta message, not two.
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});
