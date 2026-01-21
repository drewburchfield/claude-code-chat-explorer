/**
 * Test Database Helper
 *
 * Provides utilities for creating in-memory SQLite databases for testing.
 * Uses a temp file approach since better-sqlite3 requires a file path for FTS5.
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');

/**
 * Create a temporary database path for testing
 * @returns {string} Path to temp database file
 */
function createTempDbPath() {
  const tempDir = os.tmpdir();
  const uniqueId = `test-db-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(tempDir, `${uniqueId}.db`);
}

/**
 * Create a DatabaseManager instance with a temp database
 * @returns {Promise<{db: DatabaseManager, dbPath: string, cleanup: Function}>}
 */
async function createTestDatabase() {
  const DatabaseManager = require('../../src/analytics/data/DatabaseManager');
  const dbPath = createTempDbPath();

  // Silence console output during tests
  const originalLog = console.log;
  console.log = () => {};

  let db;
  let initError = null;
  try {
    db = new DatabaseManager(dbPath);
    await db.initialize();
  } catch (err) {
    initError = err;
  } finally {
    console.log = originalLog;
  }

  // Return a dummy cleanup function if initialization fails
  if (initError) {
    return {
      db: null,
      dbPath,
      cleanup: async () => {
        try {
          await fs.remove(dbPath);
          await fs.remove(`${dbPath}-wal`).catch(() => {});
          await fs.remove(`${dbPath}-shm`).catch(() => {});
        } catch (e) {
          // Ignore cleanup errors
        }
      },
      error: initError,
    };
  }

  const cleanup = async () => {
    try {
      if (db) {
        db.close();
      }
      await fs.remove(dbPath);
      // Also remove WAL and SHM files
      await fs.remove(`${dbPath}-wal`).catch(() => {});
      await fs.remove(`${dbPath}-shm`).catch(() => {});
    } catch (err) {
      // Ignore cleanup errors
    }
  };

  return { db, dbPath, cleanup };
}

/**
 * Create a mock conversation object for testing
 * @param {Object} overrides - Properties to override
 * @returns {Object} Mock conversation object
 */
function createMockConversation(overrides = {}) {
  const now = new Date();
  const id = overrides.id || `test-conv-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return {
    id,
    filePath: overrides.filePath || `/test/path/${id}.jsonl`,
    filename: overrides.filename || `${id}.jsonl`,
    project: overrides.project || 'test-project',
    messageCount: overrides.messageCount || 10,
    fileSize: overrides.fileSize || 5000,
    lastModified: overrides.lastModified || now,
    created: overrides.created || new Date(now.getTime() - 24 * 60 * 60 * 1000),
    tokenUsage: overrides.tokenUsage || {
      total: 1000,
      input: 600,
      output: 400,
    },
    modelInfo: overrides.modelInfo || {
      primaryModel: 'claude-sonnet-4-20250514',
    },
    toolUsage: overrides.toolUsage || {
      total: 5,
      tools: { Read: 3, Write: 2 },
    },
    isSubagent: overrides.isSubagent || false,
    parentId: overrides.parentId || null,
    cwd: overrides.cwd || null,
    ...overrides,
  };
}

/**
 * Create searchable content for a mock conversation
 * @param {string} content - Main content text
 * @returns {string} Searchable content string
 */
function createSearchableContent(content = 'Test conversation content about JavaScript and testing') {
  return content;
}

/**
 * Get path to test fixtures directory
 * @returns {string} Path to fixtures directory
 */
function getFixturesPath() {
  return path.join(__dirname, '..', 'fixtures');
}

/**
 * Get path to a specific conversation fixture
 * @param {string} filename - Fixture filename (e.g., 'simple.jsonl')
 * @returns {string} Full path to fixture file
 */
function getConversationFixturePath(filename) {
  return path.join(getFixturesPath(), 'conversations', filename);
}

/**
 * Create a temporary projects directory structure for testing Indexer
 * @returns {Promise<{projectsDir: string, cleanup: Function}>}
 */
async function createTempProjectsDir() {
  const tempDir = os.tmpdir();
  const uniqueId = `test-projects-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const projectsDir = path.join(tempDir, uniqueId, 'projects');

  await fs.ensureDir(projectsDir);

  const cleanup = async () => {
    try {
      await fs.remove(path.dirname(projectsDir));
    } catch (err) {
      // Ignore cleanup errors
    }
  };

  return { projectsDir, claudeDir: path.dirname(projectsDir), cleanup };
}

/**
 * Copy fixture files to a temp projects directory
 * @param {string} projectsDir - Target projects directory
 * @param {Object} options - Options for fixture setup
 * @returns {Promise<string[]>} Paths to copied files
 */
async function setupFixturesInProjectsDir(projectsDir, options = {}) {
  const {
    encodedPath = '-Users-testuser-projects-my-awesome-project',
    fixtures = ['simple.jsonl'],
  } = options;

  const projectDir = path.join(projectsDir, encodedPath);
  await fs.ensureDir(projectDir);

  const copiedPaths = [];

  for (const fixture of fixtures) {
    const sourcePath = getConversationFixturePath(fixture);
    const destPath = path.join(projectDir, fixture);
    await fs.copy(sourcePath, destPath);
    copiedPaths.push(destPath);
  }

  return copiedPaths;
}

/**
 * Create a subagent directory structure in projects dir
 * @param {string} projectsDir - Target projects directory
 * @param {string} parentId - Parent conversation ID
 * @param {string} encodedPath - Encoded project path
 * @returns {Promise<string>} Path to subagent file
 */
async function setupSubagentFixture(projectsDir, parentId, encodedPath = '-Users-testuser-projects-test-project') {
  const subagentDir = path.join(projectsDir, encodedPath, parentId, 'subagents');
  await fs.ensureDir(subagentDir);

  const sourcePath = getConversationFixturePath('subagent.jsonl');
  const destPath = path.join(subagentDir, 'agent-1.jsonl');
  await fs.copy(sourcePath, destPath);

  return destPath;
}

module.exports = {
  createTempDbPath,
  createTestDatabase,
  createMockConversation,
  createSearchableContent,
  getFixturesPath,
  getConversationFixturePath,
  createTempProjectsDir,
  setupFixturesInProjectsDir,
  setupSubagentFixture,
};
