/**
 * WatcherHealth.classifyHealth unit tests.
 *
 * The classifier consumes the /api/system/metrics shape and emits the
 * label that backs the in-app health badge. Pinning these rules down so
 * the UI doesn't silently flip a user from "stale" to "healthy" if the
 * thresholds drift.
 */
import { describe, it, expect } from 'vitest';
const WatcherHealth = require('../../src/analytics-web/components/WatcherHealth.js');

const NOW = Date.parse('2026-05-11T12:00:00Z');

function metricsAt(lastEventIso, overrides = {}) {
  return {
    timestamp: new Date(NOW).toISOString(),
    fileWatcher: { isActive: true, watchersCount: 2, ...(overrides.fileWatcher || {}) },
    fileWatcherMetrics: {
      lastEventAt: lastEventIso,
      conversationChangeEvents: 1,
      watcherErrors: 0,
      dataRefreshErrors: 0,
      ...(overrides.fileWatcherMetrics || {}),
    },
  };
}

describe('WatcherHealth.classifyHealth', () => {
  it('returns unknown when no metrics payload is provided', () => {
    expect(WatcherHealth.classifyHealth(null).status).toBe('unknown');
    expect(WatcherHealth.classifyHealth(undefined).status).toBe('unknown');
  });

  it('returns healthy when the last event is recent', () => {
    const recent = new Date(NOW - 30 * 1000).toISOString();
    const out = WatcherHealth.classifyHealth(metricsAt(recent), { now: NOW });
    expect(out.status).toBe('healthy');
    expect(out.label).toBe('live');
  });

  it('returns stale when the last event is older than 5 minutes', () => {
    const old = new Date(NOW - 10 * 60 * 1000).toISOString();
    const out = WatcherHealth.classifyHealth(metricsAt(old), { now: NOW });
    expect(out.status).toBe('stale');
    expect(out.label).toMatch(/idle 10m/);
  });

  it('returns errored when watcherErrors is non-zero, even with a fresh event', () => {
    const recent = new Date(NOW - 5 * 1000).toISOString();
    const m = metricsAt(recent, { fileWatcherMetrics: { watcherErrors: 3 } });
    const out = WatcherHealth.classifyHealth(m, { now: NOW });
    expect(out.status).toBe('errored');
    expect(out.detail).toMatch(/3 watcher/);
  });

  it('returns errored when dataRefreshErrors is non-zero', () => {
    const recent = new Date(NOW - 5 * 1000).toISOString();
    const m = metricsAt(recent, { fileWatcherMetrics: { dataRefreshErrors: 2 } });
    const out = WatcherHealth.classifyHealth(m, { now: NOW });
    expect(out.status).toBe('errored');
    expect(out.detail).toMatch(/2 refresh/);
  });

  it('returns errored when the watcher is reported inactive', () => {
    const out = WatcherHealth.classifyHealth({
      fileWatcher: { isActive: false, watchersCount: 0 },
      fileWatcherMetrics: { watcherErrors: 0, dataRefreshErrors: 0 },
    }, { now: NOW });
    expect(out.status).toBe('errored');
    expect(out.label).toMatch(/inactive/);
  });

  it('reports healthy on a freshly booted watcher with no events yet', () => {
    const out = WatcherHealth.classifyHealth({
      fileWatcher: { isActive: true, watchersCount: 2 },
      fileWatcherMetrics: { watcherErrors: 0, dataRefreshErrors: 0 },
    }, { now: NOW });
    expect(out.status).toBe('healthy');
  });

  it('ignores a malformed lastEventAt and falls back to healthy', () => {
    const out = WatcherHealth.classifyHealth(metricsAt('not-a-date'), { now: NOW });
    expect(out.status).toBe('healthy');
  });
});

describe('WatcherHealth.formatAge', () => {
  it('formats seconds, minutes, hours', () => {
    expect(WatcherHealth.formatAge(500)).toBe('<1s');
    expect(WatcherHealth.formatAge(2_000)).toBe('2s');
    expect(WatcherHealth.formatAge(90_000)).toBe('1m');
    expect(WatcherHealth.formatAge(2 * 60 * 60 * 1000)).toBe('2h');
  });
});
