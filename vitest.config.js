import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run in Node.js environment
    environment: 'node',

    // Test file patterns
    include: ['test/**/*.test.js'],

    // Exclude frontend (needs browser environment)
    exclude: ['src/analytics-web/**', 'node_modules/**'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        // Files we actively test. FileWatcher and DataCache are in scope
        // because the wiring this codebase owns around chokidar and the
        // per-file cache is exactly where long-running stability lives;
        // "chokidar is well-tested" doesn't cover our integration with it.
        // session-sharing.js has unit coverage only for the URL validator
        // path that this PR rewrote; the rest is intentionally out of
        // scope until a dedicated tests pass is added.
        'src/analytics/data/DatabaseManager.js',
        'src/analytics/data/Indexer.js',
        'src/analytics/core/ConversationAnalyzer.js',
        'src/analytics/core/FileWatcher.js',
        'src/analytics/data/DataCache.js',
      ],
      exclude: [
        'src/analytics-web/**',
        'test/**',
        'node_modules/**',
        // Files we chose not to test (per YAGNI):
        // - ProcessDetector: platform-specific
        // - DatabaseBackend: thin wrapper layer
        // - AgentAnalyzer: low priority
        // - SessionAnalyzer: low priority
        // - TokenCalculator: low priority
      ],
      // Coverage thresholds
      thresholds: {
        statements: 60,
        branches: 60,
        functions: 60,
        lines: 60,
      },
    },

    // Timeout for tests
    testTimeout: 30000,

    // Run tests sequentially to avoid SQLite locking issues
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },

    // Reporter configuration
    reporters: ['verbose'],
  },
});
