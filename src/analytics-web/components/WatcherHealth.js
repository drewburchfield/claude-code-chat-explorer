/**
 * WatcherHealth — derive a UI status from the runtime metrics payload.
 *
 * The state machine is small and decoupled from the DOM so the rules can
 * be tested under vitest without a browser. The browser bundle adds a
 * setInterval polling loop that calls into `classifyHealth` and applies
 * the result to a badge element.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WatcherHealth = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  // Anything older than this without a recent event counts as "stale".
  // Chosen to be safely above the 2-minute periodic fallback so a single
  // missed tick doesn't yellow-flag the badge.
  const STALE_AFTER_MS = 5 * 60 * 1000;

  /**
   * Classify a runtime metrics snapshot into a single badge status.
   *
   * @param {Object} metrics - The /api/system/metrics response shape:
   *   {
   *     timestamp,
   *     fileWatcher: { isActive, watchersCount, lastEventAt, ... },
   *     fileWatcherMetrics: {
   *       conversationChangeEvents, watcherErrors, dataRefreshErrors,
   *       lastEventAt, ...
   *     },
   *   }
   * @param {Object} [opts]
   * @param {number} [opts.now] - Inject "now" so the test suite can pin
   *   wall-clock comparisons. Defaults to Date.now().
   * @returns {{ status: 'healthy'|'stale'|'errored'|'unknown', label: string, detail: string }}
   */
  function classifyHealth(metrics, opts) {
    const now = (opts && typeof opts.now === 'number') ? opts.now : Date.now();
    if (!metrics || typeof metrics !== 'object') {
      return { status: 'unknown', label: 'no metrics', detail: 'No metrics response' };
    }

    const watcher = metrics.fileWatcher || {};
    const watcherMetrics = metrics.fileWatcherMetrics || {};

    const watcherErrors = Number(watcherMetrics.watcherErrors || 0);
    const dataRefreshErrors = Number(watcherMetrics.dataRefreshErrors || 0);
    if (watcherErrors > 0 || dataRefreshErrors > 0) {
      const parts = [];
      if (watcherErrors > 0) parts.push(`${watcherErrors} watcher`);
      if (dataRefreshErrors > 0) parts.push(`${dataRefreshErrors} refresh`);
      return {
        status: 'errored',
        label: 'watcher errors',
        detail: `Errors: ${parts.join(', ')}`,
      };
    }

    // Watcher disabled / not yet initialised.
    if (watcher.isActive === false || (watcher.watchersCount === 0 && !watcher.isActive)) {
      return { status: 'errored', label: 'watcher inactive', detail: 'File watching not running' };
    }

    const lastEventIso = watcherMetrics.lastEventAt || watcher.lastEventAt || null;
    if (lastEventIso) {
      const lastEventMs = Date.parse(lastEventIso);
      if (Number.isFinite(lastEventMs)) {
        const ageMs = now - lastEventMs;
        if (ageMs > STALE_AFTER_MS) {
          const ageMin = Math.floor(ageMs / 60000);
          return { status: 'stale', label: `idle ${ageMin}m`, detail: `Last event ${ageMin} min ago` };
        }
        return { status: 'healthy', label: 'live', detail: `Last event ${formatAge(ageMs)} ago` };
      }
    }

    // Watcher is active and no errors, but we've never seen a per-file
    // event yet. Common on a freshly booted container — treat as healthy
    // rather than alarming the user.
    return { status: 'healthy', label: 'live', detail: 'Watcher active, awaiting first event' };
  }

  function formatAge(ms) {
    if (ms < 1000) return '<1s';
    if (ms < 60 * 1000) return Math.floor(ms / 1000) + 's';
    if (ms < 60 * 60 * 1000) return Math.floor(ms / 60000) + 'm';
    return Math.floor(ms / 3600000) + 'h';
  }

  return {
    STALE_AFTER_MS,
    classifyHealth,
    formatAge,
  };
}));
