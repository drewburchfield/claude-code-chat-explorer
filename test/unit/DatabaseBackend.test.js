/**
 * DatabaseBackend tests - focused on indexing status and the background
 * (non-blocking) initialization path used in production so an upgrade
 * reindex doesn't black out the server.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('fs-extra');
const { createTempDbPath, createTempProjectsDir, setupFixturesInProjectsDir } = require('../helpers/test-db');
const DatabaseBackend = require('../../src/analytics/data/DatabaseBackend');

async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
}

describe('DatabaseBackend indexing status', () => {
  let projectsDir, claudeDir, projectsCleanup, dbPath, backend;

  beforeEach(async () => {
    ({ projectsDir, claudeDir, cleanup: projectsCleanup } = await createTempProjectsDir());
    await setupFixturesInProjectsDir(projectsDir, { fixtures: ['simple.jsonl'] });
    dbPath = createTempDbPath();
    const origLog = console.log; console.log = () => {};
    global.__origLog = origLog;
  });

  afterEach(async () => {
    console.log = global.__origLog;
    if (backend) backend.close();
    await projectsCleanup();
    await fs.remove(dbPath).catch(() => {});
  });

  it('reports idle with stats after a synchronous initialize (default)', async () => {
    backend = new DatabaseBackend(claudeDir, { dbPath });
    await backend.initialize();

    expect(backend.isInitialized).toBe(true);
    const status = backend.getIndexStatus();
    expect(status.state).toBe('idle');
    expect(status.lastStats).toBeTruthy();
    expect(status.finishedAt).toBeGreaterThan(0);
  });

  it('with backgroundIndex, resolves initialize before indexing finishes, then completes', async () => {
    backend = new DatabaseBackend(claudeDir, { dbPath, backgroundIndex: true });
    await backend.initialize();

    // Server is ready immediately, regardless of index progress.
    expect(backend.isInitialized).toBe(true);

    // The background index eventually completes and reports idle + stats.
    const done = await waitFor(() => backend.getIndexStatus().state === 'idle' && backend.getIndexStatus().lastStats);
    expect(done).toBe(true);
    expect(backend.getIndexStatus().lastStats.filesIndexed).toBeGreaterThanOrEqual(1);
  });
});
