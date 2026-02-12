const chalk = require('chalk');
const chokidar = require('chokidar');
const path = require('path');

/**
 * FileWatcher - Handles file system watching and automatic data refresh
 * Extracted from monolithic analytics.js for better maintainability
 */
class FileWatcher {
  constructor() {
    this.watchers = [];
    this.intervals = [];
    this.isActive = false;
    this.fileActivity = new Map();
    this.typingTimeout = new Map();
    this.conversationChangeTimers = new Map();
    this.metrics = {
      startedAt: null,
      lastEventAt: null,
      lastRefreshAt: null,
      conversationChangeEvents: 0,
      conversationDebounceResets: 0,
      conversationCallbacksExecuted: 0,
      conversationCallbackErrors: 0,
      dataRefreshAttempts: 0,
      dataRefreshErrors: 0,
      refreshTriggers: {
        conversationAdd: 0,
        projectAddDir: 0,
        periodic: 0,
        manual: 0,
        unknown: 0
      },
      watcherErrors: 0,
      lastWatcherError: null
    };
  }

  /**
   * Setup file watchers for real-time updates
   * @param {string} claudeDir - Path to Claude directory
   * @param {Function} dataRefreshCallback - Callback to refresh data
   * @param {Function} processRefreshCallback - Callback to refresh process data
   * @param {Object} dataCache - DataCache instance for invalidation
   */
  setupFileWatchers(claudeDir, dataRefreshCallback, processRefreshCallback, dataCache = null, conversationChangeCallback = null) {
    console.log(chalk.blue('👀 Setting up file watchers for real-time updates...'));

    this.claudeDir = claudeDir;
    this.dataRefreshCallback = dataRefreshCallback;
    this.processRefreshCallback = processRefreshCallback;
    this.dataCache = dataCache;
    this.conversationChangeCallback = conversationChangeCallback;
    this.metrics.startedAt = new Date().toISOString();

    this.setupConversationWatcher();
    this.setupProjectWatcher();
    this.setupPeriodicRefresh();
    
    this.isActive = true;
  }

  /**
   * Setup watcher for conversation files (.jsonl)
   */
  setupConversationWatcher() {
    const conversationWatcher = chokidar.watch([
      path.join(this.claudeDir, '**/*.jsonl')
    ], {
      persistent: true,
      ignoreInitial: true,
      ignored: (watchPath) => this.shouldIgnoreWatchPath(watchPath),
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100
      }
    });

    conversationWatcher.on('change', async (filePath) => {
      this.metrics.lastEventAt = new Date().toISOString();
      this.metrics.conversationChangeEvents += 1;
      const conversationId = this.extractConversationId(filePath);

      if (this.dataCache && filePath) {
        this.dataCache.invalidateFile(filePath);
      }

      if (this.conversationChangeCallback && conversationId) {
        this.debouncedConversationChange(conversationId, filePath);
      }
    });

    conversationWatcher.on('add', async () => {
      await this.triggerDataRefresh('conversationAdd');
    });

    conversationWatcher.on('error', (error) => {
      this.recordWatcherError(error, 'conversationWatcher');
    });

    this.watchers.push(conversationWatcher);
  }

  /**
   * Setup watcher for project directories
   */
  setupProjectWatcher() {
    const projectWatcher = chokidar.watch(this.claudeDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 2,
      ignored: (watchPath) => this.shouldIgnoreWatchPath(watchPath) || /\.jsonl$/.test(watchPath)
    });

    projectWatcher.on('addDir', async () => {
      await this.triggerDataRefresh('projectAddDir');
    });

    projectWatcher.on('error', (error) => {
      this.recordWatcherError(error, 'projectWatcher');
    });

    this.watchers.push(projectWatcher);
  }

  /**
   * Setup periodic refresh intervals
   */
  setupPeriodicRefresh() {
    // Periodic refresh to catch any missed changes (reduced frequency)
    const dataRefreshInterval = setInterval(async () => {
      await this.triggerDataRefresh('periodic');
    }, 120000); // Every 2 minutes (reduced from 30 seconds)

    this.intervals.push(dataRefreshInterval);

    // Process updates for active processes (reduced frequency)
    const processRefreshInterval = setInterval(async () => {
      if (this.processRefreshCallback) {
        await this.processRefreshCallback();
      }
    }, 30000); // Every 30 seconds (reduced from 10 seconds)

    this.intervals.push(processRefreshInterval);
  }

  /**
   * Extract conversation ID from file path
   * @param {string} filePath - Path to the conversation file
   * @returns {string|null} Conversation ID or null if not found
   */
  extractConversationId(filePath) {
    try {
      // Handle different path formats:
      // /Users/user/.claude/projects/PROJECT_NAME/conversation.jsonl -> PROJECT_NAME
      // /Users/user/.claude/CONVERSATION_ID.jsonl -> CONVERSATION_ID
      
      const pathParts = filePath.split(path.sep);
      const fileName = pathParts[pathParts.length - 1];
      
      if (fileName === 'conversation.jsonl') {
        // Project-based conversation
        const projectName = pathParts[pathParts.length - 2];
        return projectName;
      } else if (fileName.endsWith('.jsonl')) {
        // Direct conversation file
        return fileName.replace('.jsonl', '');
      }
      
      return null;
    } catch (error) {
      console.error(chalk.red('Error extracting conversation ID:'), error);
      return null;
    }
  }

  /**
   * Debounce conversation change callbacks per conversation ID
   * @param {string} conversationId - Conversation ID
   * @param {string} filePath - File path that changed
   */
  debouncedConversationChange(conversationId, filePath) {
    const existing = this.conversationChangeTimers.get(conversationId);
    if (existing) {
      clearTimeout(existing);
      this.metrics.conversationDebounceResets += 1;
    }

    const timer = setTimeout(async () => {
      this.conversationChangeTimers.delete(conversationId);
      try {
        await this.conversationChangeCallback(conversationId, filePath);
        this.metrics.conversationCallbacksExecuted += 1;
      } catch (error) {
        this.metrics.conversationCallbackErrors += 1;
        console.error(chalk.red(`Error in conversation change callback for ${conversationId}:`), error.message);
      }
    }, 1000);

    this.conversationChangeTimers.set(conversationId, timer);
  }

  /**
   * Set notification manager for state notifications
   * @param {Object} notificationManager - NotificationManager instance
   */
  setNotificationManager(notificationManager) {
    this.notificationManager = notificationManager;
  }

  /**
   * Trigger data refresh with source tagging for observability
   * @param {string} source - Source of refresh trigger
   */
  async triggerDataRefresh(source = 'unknown') {
    if (Object.prototype.hasOwnProperty.call(this.metrics.refreshTriggers, source)) {
      this.metrics.refreshTriggers[source] += 1;
    } else {
      this.metrics.refreshTriggers.unknown += 1;
    }

    this.metrics.dataRefreshAttempts += 1;
    this.metrics.lastRefreshAt = new Date().toISOString();

    try {
      if (this.dataRefreshCallback) {
        await this.dataRefreshCallback();
      }
    } catch (error) {
      this.metrics.dataRefreshErrors += 1;
      console.error(chalk.red('Error during data refresh:'), error.message);
    }
  }

  /**
   * Record watcher errors without crashing the process
   * @param {Error} error - Error object
   * @param {string} source - Error source
   */
  recordWatcherError(error, source = 'watcher') {
    this.metrics.watcherErrors += 1;
    this.metrics.lastWatcherError = {
      source,
      message: error?.message || String(error),
      code: error?.code || null,
      path: error?.path || null,
      timestamp: new Date().toISOString()
    };
    console.warn(chalk.yellow(`⚠️  File watcher error [${source}]:`), this.metrics.lastWatcherError.message);
  }

  /**
   * Ignore known problematic non-conversation paths under ~/.claude
   * @param {string} watchPath - Path chokidar is evaluating
   * @returns {boolean} True if path should be ignored
   */
  shouldIgnoreWatchPath(watchPath) {
    if (!watchPath) return false;
    const normalizedPath = String(watchPath).replace(/\\/g, '/');

    // .claude/debug/latest can be an invalid symlink target in some setups.
    // Ignore the debug tree because it does not contain conversation sources.
    return normalizedPath.includes('/.claude/debug/') || normalizedPath.endsWith('/.claude/debug');
  }

  /**
   * Add a custom watcher
   * @param {Object} watcher - Chokidar watcher instance
   */
  addWatcher(watcher) {
    this.watchers.push(watcher);
  }

  /**
   * Add a custom interval
   * @param {number} intervalId - Interval ID from setInterval
   */
  addInterval(intervalId) {
    this.intervals.push(intervalId);
  }

  /**
   * Pause all watchers and intervals
   */
  pause() {
    console.log(chalk.yellow('⏸️  Pausing file watchers...'));
    
    // Pause watchers (they will still exist but not trigger events)
    this.watchers.forEach(watcher => {
      if (watcher.unwatch) {
        // Temporarily remove all watched paths
        const watchedPaths = watcher.getWatched();
        Object.keys(watchedPaths).forEach(dir => {
          watchedPaths[dir].forEach(file => {
            watcher.unwatch(path.join(dir, file));
          });
        });
      }
    });

    this.isActive = false;
  }

  /**
   * Resume all watchers
   */
  resume() {
    if (!this.isActive && this.claudeDir) {
      console.log(chalk.green('▶️  Resuming file watchers...'));
      
      // Clear existing watchers
      this.stop();
      
      // Restart watchers
      this.setupFileWatchers(
        this.claudeDir, 
        this.dataRefreshCallback, 
        this.processRefreshCallback,
        this.dataCache,
        this.conversationChangeCallback
      );
    }
  }

  /**
   * Stop and cleanup all watchers and intervals
   */
  stop() {
    console.log(chalk.red('🛑 Stopping file watchers...'));

    this.watchers.forEach(watcher => {
      try {
        watcher.close();
      } catch (error) {
        console.warn(chalk.yellow('Warning: Error closing watcher:'), error.message);
      }
    });

    this.intervals.forEach(intervalId => {
      clearInterval(intervalId);
    });

    for (const timer of this.conversationChangeTimers.values()) {
      clearTimeout(timer);
    }
    this.conversationChangeTimers.clear();

    for (const timer of this.typingTimeout.values()) {
      clearTimeout(timer);
    }
    this.typingTimeout.clear();

    this.watchers = [];
    this.intervals = [];
    this.isActive = false;
  }

  /**
   * Get watcher status
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      isActive: this.isActive,
      watcherCount: this.watchers.length,
      intervalCount: this.intervals.length,
      watchedDir: this.claudeDir
    };
  }

  /**
   * Check if watchers are active
   * @returns {boolean} True if watchers are active
   */
  isWatching() {
    return this.isActive && this.watchers.length > 0;
  }

  /**
   * Get list of watched paths (for debugging)
   * @returns {Array} Array of watched paths
   */
  getWatchedPaths() {
    const watchedPaths = [];
    
    this.watchers.forEach(watcher => {
      if (watcher.getWatched) {
        const watched = watcher.getWatched();
        Object.keys(watched).forEach(dir => {
          watched[dir].forEach(file => {
            watchedPaths.push(path.join(dir, file));
          });
        });
      }
    });

    return watchedPaths;
  }

  /**
   * Set debounced refresh to avoid spam
   * @param {number} debounceMs - Debounce time in milliseconds
   */
  setDebounce(debounceMs = 200) {
    let debounceTimeout;
    const originalCallback = this.dataRefreshCallback;
    
    this.dataRefreshCallback = async (...args) => {
      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(async () => {
        if (originalCallback) {
          await originalCallback(...args);
        }
      }, debounceMs);
    };
  }

  /**
   * Force immediate refresh
   */
  async forceRefresh() {
    await this.triggerDataRefresh('manual');
    if (this.processRefreshCallback) {
      await this.processRefreshCallback();
    }
  }

  /**
   * Get runtime watcher metrics
   * @returns {Object} Metrics snapshot
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeDebounceTimers: this.conversationChangeTimers.size,
      activeTypingTimers: this.typingTimeout.size,
      watcherCount: this.watchers.length,
      intervalCount: this.intervals.length,
      isActive: this.isActive
    };
  }
}

module.exports = FileWatcher;
