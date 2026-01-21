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
        // Only measure coverage for files we're actively testing
        'src/analytics/data/DatabaseManager.js',
        'src/analytics/data/Indexer.js',
        'src/analytics/core/ConversationAnalyzer.js',
      ],
      exclude: [
        'src/analytics-web/**',
        'test/**',
        'node_modules/**',
        // Files we chose not to test (per YAGNI):
        // - FileWatcher: chokidar is well-tested
        // - ProcessDetector: platform-specific
        // - DataCache: complex state management
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
