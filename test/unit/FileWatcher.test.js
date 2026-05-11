/**
 * FileWatcher unit tests
 *
 * Focused on the wiring this codebase owns (env-var driven polling mode,
 * setupFileWatchers callback plumbing). Chokidar itself is mocked because
 * we are testing the integration boundary, not the upstream library.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const chokidar = require('chokidar');
const FileWatcher = require('../../src/analytics/core/FileWatcher');

function makeFakeWatcher() {
  const handlers = {};
  return {
    on(event, handler) {
      handlers[event] = handler;
      return this;
    },
    close: vi.fn().mockResolvedValue(undefined),
    unwatch: vi.fn(),
    getWatched: vi.fn().mockReturnValue({}),
    _emit(event, ...args) {
      if (handlers[event]) return handlers[event](...args);
    },
  };
}

describe('FileWatcher.buildChokidarOptions', () => {
  let originalUsePolling;
  let originalInterval;

  beforeEach(() => {
    originalUsePolling = process.env.CHOKIDAR_USEPOLLING;
    originalInterval = process.env.CHOKIDAR_INTERVAL;
    delete process.env.CHOKIDAR_USEPOLLING;
    delete process.env.CHOKIDAR_INTERVAL;
  });

  afterEach(() => {
    if (originalUsePolling === undefined) delete process.env.CHOKIDAR_USEPOLLING;
    else process.env.CHOKIDAR_USEPOLLING = originalUsePolling;
    if (originalInterval === undefined) delete process.env.CHOKIDAR_INTERVAL;
    else process.env.CHOKIDAR_INTERVAL = originalInterval;
  });

  it('defaults to native fs events with usePolling=false', () => {
    const fw = new FileWatcher();
    fw.claudeDir = '/tmp/claude';
    const opts = fw.buildChokidarOptions();
    expect(opts.usePolling).toBe(false);
    expect(opts.interval).toBe(2000);
    expect(opts.binaryInterval).toBe(4000);
    expect(opts.persistent).toBe(true);
    expect(opts.ignoreInitial).toBe(true);
  });

  it('honours CHOKIDAR_USEPOLLING=1', () => {
    process.env.CHOKIDAR_USEPOLLING = '1';
    const fw = new FileWatcher();
    fw.claudeDir = '/tmp/claude';
    expect(fw.buildChokidarOptions().usePolling).toBe(true);
  });

  it('honours CHOKIDAR_USEPOLLING=true (case insensitive)', () => {
    process.env.CHOKIDAR_USEPOLLING = 'TRUE';
    const fw = new FileWatcher();
    fw.claudeDir = '/tmp/claude';
    expect(fw.buildChokidarOptions().usePolling).toBe(true);
  });

  it('honours CHOKIDAR_INTERVAL with a custom value', () => {
    process.env.CHOKIDAR_USEPOLLING = '1';
    process.env.CHOKIDAR_INTERVAL = '500';
    const fw = new FileWatcher();
    fw.claudeDir = '/tmp/claude';
    const opts = fw.buildChokidarOptions();
    expect(opts.interval).toBe(500);
    expect(opts.binaryInterval).toBe(1000);
  });

  it('ignores garbage CHOKIDAR_INTERVAL and falls back to default', () => {
    process.env.CHOKIDAR_INTERVAL = 'not-a-number';
    const fw = new FileWatcher();
    fw.claudeDir = '/tmp/claude';
    expect(fw.buildChokidarOptions().interval).toBe(2000);
  });

  it('lets caller overrides override base options', () => {
    const fw = new FileWatcher();
    fw.claudeDir = '/tmp/claude';
    const opts = fw.buildChokidarOptions({ depth: 5, persistent: false });
    expect(opts.depth).toBe(5);
    expect(opts.persistent).toBe(false);
  });
});

describe('FileWatcher.setupFileWatchers callback plumbing', () => {
  let originalWatch;
  let originalUsePolling;
  let fakeWatchers;
  let watchCalls;

  beforeEach(() => {
    originalUsePolling = process.env.CHOKIDAR_USEPOLLING;
    originalWatch = chokidar.watch;
    fakeWatchers = [];
    watchCalls = [];
    chokidar.watch = (paths, options) => {
      watchCalls.push({ paths, options });
      const fake = makeFakeWatcher();
      fakeWatchers.push(fake);
      return fake;
    };
  });

  afterEach(() => {
    chokidar.watch = originalWatch;
    if (originalUsePolling === undefined) delete process.env.CHOKIDAR_USEPOLLING;
    else process.env.CHOKIDAR_USEPOLLING = originalUsePolling;
  });

  it('passes usePolling:true to chokidar when env enables it', () => {
    process.env.CHOKIDAR_USEPOLLING = '1';
    const fw = new FileWatcher();
    fw.setupFileWatchers('/tmp/claude', () => {}, () => {});
    expect(watchCalls.length).toBeGreaterThan(0);
    for (const call of watchCalls) {
      expect(call.options.usePolling).toBe(true);
      expect(call.options.interval).toBe(2000);
    }
    return fw.stop();
  });

  it('invokes fileChangeCallback when chokidar fires a change event', async () => {
    const fileChange = vi.fn().mockResolvedValue(undefined);
    const fw = new FileWatcher();
    fw.setupFileWatchers(
      '/tmp/claude',
      () => {},
      () => {},
      null,
      null,
      fileChange
    );
    // First registered watcher is the conversation watcher (jsonl glob).
    const convWatcher = fakeWatchers[0];
    await convWatcher._emit('change', '/tmp/claude/projects/x/abc.jsonl');
    expect(fileChange).toHaveBeenCalledWith('/tmp/claude/projects/x/abc.jsonl');
    return fw.stop();
  });

  it('invokes fileChangeCallback when chokidar fires an add event', async () => {
    const fileChange = vi.fn().mockResolvedValue(undefined);
    const fw = new FileWatcher();
    fw.setupFileWatchers(
      '/tmp/claude',
      () => {},
      () => {},
      null,
      null,
      fileChange
    );
    const convWatcher = fakeWatchers[0];
    await convWatcher._emit('add', '/tmp/claude/projects/x/new.jsonl');
    expect(fileChange).toHaveBeenCalledWith('/tmp/claude/projects/x/new.jsonl');
    return fw.stop();
  });

  it('still invokes legacy callbacks when no fileChangeCallback is provided', async () => {
    const dataRefresh = vi.fn().mockResolvedValue(undefined);
    const fw = new FileWatcher();
    fw.setupFileWatchers('/tmp/claude', dataRefresh, () => {});
    const convWatcher = fakeWatchers[0];
    await convWatcher._emit('add', '/tmp/claude/projects/x/new.jsonl');
    expect(dataRefresh).toHaveBeenCalled();
    return fw.stop();
  });
});
