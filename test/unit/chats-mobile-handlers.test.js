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
