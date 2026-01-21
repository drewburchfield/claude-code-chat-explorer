const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');

/**
 * DatabaseManager - SQLite + FTS5 backend for efficient conversation storage and search
 *
 * Replaces the in-memory loading approach with a persistent indexed database.
 * FTS5 provides full-text search with sub-millisecond query times.
 */
class DatabaseManager {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.sqlite3 = null;
  }

  /**
   * Initialize database connection and create schema if needed
   */
  async initialize() {
    // Dynamic import of better-sqlite3 (synchronous, fast SQLite binding)
    try {
      this.sqlite3 = require('better-sqlite3');
    } catch (err) {
      console.error('better-sqlite3 not installed. Run: npm install better-sqlite3');
      throw err;
    }

    // Ensure directory exists
    await fs.ensureDir(path.dirname(this.dbPath));

    // Open database with WAL mode for better concurrent read performance
    this.db = new this.sqlite3(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000'); // 64MB cache
    this.db.pragma('temp_store = MEMORY');

    // Create schema
    this._createSchema();

    console.log(`📦 Database initialized at ${this.dbPath}`);
    return this;
  }

  /**
   * Create database tables and FTS5 virtual table
   */
  _createSchema() {
    try {
      // Main conversations table - stores metadata
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          file_path TEXT UNIQUE NOT NULL,
          filename TEXT NOT NULL,
          project TEXT,
          message_count INTEGER DEFAULT 0,
          file_size INTEGER DEFAULT 0,
          last_modified INTEGER NOT NULL,
          created INTEGER NOT NULL,
          tokens_total INTEGER DEFAULT 0,
          tokens_input INTEGER DEFAULT 0,
          tokens_output INTEGER DEFAULT 0,
          primary_model TEXT,
          indexed_at INTEGER NOT NULL
        )
      `);

      // Tool usage tracking
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tool_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          call_count INTEGER DEFAULT 1,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
          UNIQUE(conversation_id, tool_name)
        )
      `);

      // FTS5 virtual table for full-text search on conversation content
      // Tokenize with unicode61 for proper handling of all characters
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
          conversation_id,
          content,
          project,
          tokenize='unicode61 remove_diacritics 2'
        )
      `);

      // File tracking table - for incremental indexing
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS file_index (
          file_path TEXT PRIMARY KEY,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL,
          indexed_at INTEGER NOT NULL
        )
      `);

      // Create indexes for common queries
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_conversations_last_modified ON conversations(last_modified DESC);
        CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project);
        CREATE INDEX IF NOT EXISTS idx_conversations_tokens ON conversations(tokens_total DESC);
        CREATE INDEX IF NOT EXISTS idx_tool_usage_tool ON tool_usage(tool_name);
      `);
    } catch (err) {
      const sqliteVersion = this.db.pragma('sqlite_version', { simple: true });
      console.error(`❌ Schema creation failed: ${err.message}`);
      console.error(`   SQLite version: ${sqliteVersion}`);
      console.error(`   Database path: ${this.dbPath}`);
      throw new Error(`Database schema creation failed: ${err.message}. Try deleting ${this.dbPath} and restarting.`);
    }

    // Migration: Add subagent columns if they don't exist
    this._migrateSubagentColumns();

    // Migration: Add cwd column for project name resolution
    this._migrateCwdColumn();
  }

  /**
   * Migrate database to add cwd column for better project name resolution
   * @private
   */
  _migrateCwdColumn() {
    try {
      const columns = this.db.prepare("PRAGMA table_info(conversations)").all();
      const columnNames = columns.map(c => c.name);

      if (!columnNames.includes('cwd')) {
        this.db.exec(`ALTER TABLE conversations ADD COLUMN cwd TEXT`);
      }
    } catch (err) {
      console.warn(chalk.yellow(`⚠️ CWD column migration failed: ${err.message}`));
    }
  }

  /**
   * Migrate database to add subagent columns
   * @private
   */
  _migrateSubagentColumns() {
    try {
      // Check if columns exist by querying table info
      const columns = this.db.prepare("PRAGMA table_info(conversations)").all();
      const columnNames = columns.map(c => c.name);

      let needsDataMigration = false;

      if (!columnNames.includes('is_subagent')) {
        this.db.exec(`ALTER TABLE conversations ADD COLUMN is_subagent INTEGER DEFAULT 0`);
        needsDataMigration = true;
      }

      if (!columnNames.includes('parent_id')) {
        this.db.exec(`ALTER TABLE conversations ADD COLUMN parent_id TEXT`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_id)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_subagent ON conversations(is_subagent)`);
        needsDataMigration = true;
      }

      // One-time data migration: update existing records based on file_path
      // Subagent paths contain /subagents/ directory
      // Run if columns were just added, OR if there are unmigrated records
      if (needsDataMigration || this._hasUnmigratedSubagents()) {
        console.log('📦 Running one-time subagent data migration...');
        this._migrateExistingSubagentData();
      }
    } catch (err) {
      console.error(chalk.red(`⚠️ Subagent column migration failed: ${err.message}`));
      console.error(chalk.gray('   Subagent hierarchy features may not work correctly.'));
      // Don't throw - allow the application to continue with reduced functionality
    }
  }

  /**
   * Check if there are subagent records that haven't been migrated
   * @private
   */
  _hasUnmigratedSubagents() {
    try {
      const count = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM conversations
        WHERE file_path LIKE '%/subagents/%' AND (is_subagent = 0 OR is_subagent IS NULL)
      `).get();
      return count && count.cnt > 0;
    } catch (err) {
      console.warn(chalk.yellow(`⚠️ Could not check for unmigrated subagents: ${err.message}`));
      return false; // Assume no migration needed on error
    }
  }

  /**
   * Update existing conversation records to detect subagents from file paths
   * @private
   */
  _migrateExistingSubagentData() {
    try {
      // Get all conversations that have /subagents/ in their path
      const subagentRows = this.db.prepare(`
        SELECT id, file_path FROM conversations WHERE file_path LIKE '%/subagents/%'
      `).all();

      if (subagentRows.length === 0) {
        console.log('📦 No subagent records found to migrate');
        return;
      }

      console.log(`📦 Migrating ${subagentRows.length} subagent records...`);

      const updateStmt = this.db.prepare(`
        UPDATE conversations SET is_subagent = 1, parent_id = ? WHERE id = ?
      `);

      const transaction = this.db.transaction((rows) => {
        for (const row of rows) {
          // Extract parent ID from path: .../parent-id/subagents/agent-xxx.jsonl
          const parts = row.file_path.split('/');
          const subagentIdx = parts.indexOf('subagents');
          if (subagentIdx > 0) {
            const parentId = parts[subagentIdx - 1];
            updateStmt.run(parentId, row.id);
          }
        }
      });

      transaction(subagentRows);
      console.log(`📦 Migrated ${subagentRows.length} subagent records`);
    } catch (err) {
      console.error(chalk.red(`⚠️ Subagent data migration failed: ${err.message}`));
      console.error(chalk.gray('   Some subagent records may not be correctly identified.'));
      // Don't throw - allow the application to continue
    }
  }

  /**
   * Check if a file needs re-indexing based on mtime
   * @param {string} filePath - Path to JSONL file
   * @param {number} mtime - File modification time (ms since epoch)
   * @param {number} size - File size in bytes
   * @returns {boolean} True if file needs indexing
   */
  needsIndexing(filePath, mtime, size) {
    const stmt = this.db.prepare(`
      SELECT mtime, size FROM file_index WHERE file_path = ?
    `);
    const row = stmt.get(filePath);

    if (!row) return true;
    return row.mtime !== mtime || row.size !== size;
  }

  /**
   * Insert or update a conversation in the database
   * @param {Object} conversation - Conversation data object
   * @param {string} searchableContent - Text content for FTS indexing
   */
  upsertConversation(conversation, searchableContent) {
    const now = Date.now();

    // Begin transaction for atomicity
    const insertConv = this.db.prepare(`
      INSERT OR REPLACE INTO conversations (
        id, file_path, filename, project, message_count, file_size,
        last_modified, created, tokens_total, tokens_input, tokens_output,
        primary_model, indexed_at, is_subagent, parent_id, cwd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const deleteOldFts = this.db.prepare(`
      DELETE FROM conversation_fts WHERE conversation_id = ?
    `);

    const insertFts = this.db.prepare(`
      INSERT INTO conversation_fts (conversation_id, content, project)
      VALUES (?, ?, ?)
    `);

    const updateFileIndex = this.db.prepare(`
      INSERT OR REPLACE INTO file_index (file_path, mtime, size, indexed_at)
      VALUES (?, ?, ?, ?)
    `);

    const deleteOldTools = this.db.prepare(`
      DELETE FROM tool_usage WHERE conversation_id = ?
    `);

    const insertTool = this.db.prepare(`
      INSERT OR REPLACE INTO tool_usage (conversation_id, tool_name, call_count)
      VALUES (?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      // Insert/update main conversation record
      insertConv.run(
        conversation.id,
        conversation.filePath,
        conversation.filename,
        conversation.project || null,
        conversation.messageCount || 0,
        conversation.fileSize || 0,
        conversation.lastModified?.getTime() || now,
        conversation.created?.getTime() || now,
        conversation.tokenUsage?.total || 0,
        conversation.tokenUsage?.input || 0,
        conversation.tokenUsage?.output || 0,
        conversation.modelInfo?.primaryModel || null,
        now,
        conversation.isSubagent ? 1 : 0,
        conversation.parentId || null,
        conversation.cwd || null
      );

      // Update FTS index
      deleteOldFts.run(conversation.id);
      if (searchableContent && searchableContent.trim()) {
        insertFts.run(conversation.id, searchableContent, conversation.project || '');
      }

      // Update file tracking
      updateFileIndex.run(
        conversation.filePath,
        conversation.lastModified?.getTime() || now,
        conversation.fileSize || 0,
        now
      );

      // Update tool usage
      deleteOldTools.run(conversation.id);
      if (conversation.toolUsage && conversation.toolUsage.tools) {
        for (const [toolName, count] of Object.entries(conversation.toolUsage.tools)) {
          insertTool.run(conversation.id, toolName, count);
        }
      }
    });

    transaction();
  }

  /**
   * Get all conversations with pagination support
   * @param {Object} options - Query options
   * @param {number} options.limit - Max results (default 100)
   * @param {number} options.offset - Skip first N results (default 0)
   * @param {string} options.sortBy - Sort field (default 'last_modified')
   * @param {string} options.sortOrder - 'ASC' or 'DESC' (default 'DESC')
   * @param {string} options.project - Filter by project name
   * @returns {Array} Array of conversation objects
   */
  getConversations(options = {}) {
    const {
      limit = 100,
      offset = 0,
      sortBy = 'last_modified',
      sortOrder = 'DESC',
      project = null,
      includeSubagents = false
    } = options;

    // Whitelist allowed sort columns to prevent SQL injection
    const allowedSorts = ['last_modified', 'created', 'tokens_total', 'message_count', 'file_size'];
    const safeSort = allowedSorts.includes(sortBy) ? sortBy : 'last_modified';
    const safeOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    let sql = `
      SELECT
        id, file_path, filename, project, message_count, file_size,
        last_modified, created, tokens_total, tokens_input, tokens_output,
        primary_model, indexed_at, is_subagent, parent_id
      FROM conversations
    `;

    const conditions = [];
    const params = [];

    // Filter out subagents unless explicitly included
    if (!includeSubagents) {
      conditions.push('(is_subagent = 0 OR is_subagent IS NULL)');
    }

    if (project) {
      conditions.push('project = ?');
      params.push(project);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY ${safeSort} ${safeOrder} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);

    return rows.map(row => this._rowToConversation(row));
  }

  /**
   * Full-text search across conversation content
   * @param {string} query - Search query
   * @param {Object} options - Query options
   * @returns {Array} Matching conversations with relevance scores
   */
  searchConversations(query, options = {}) {
    const { limit = 50, offset = 0, includeSubagents = false } = options;

    if (!query || !query.trim()) {
      return this.getConversations(options);
    }

    try {
      // Build subagent filter
      const subagentFilter = includeSubagents
        ? ''
        : 'AND (c.is_subagent = 0 OR c.is_subagent IS NULL)';

      // FTS5 query with BM25 ranking
      const stmt = this.db.prepare(`
        SELECT
          c.id, c.file_path, c.filename, c.project, c.message_count, c.file_size,
          c.last_modified, c.created, c.tokens_total, c.tokens_input, c.tokens_output,
          c.primary_model, c.indexed_at, c.is_subagent, c.parent_id,
          bm25(conversation_fts) as relevance
        FROM conversation_fts fts
        JOIN conversations c ON fts.conversation_id = c.id
        WHERE conversation_fts MATCH ? ${subagentFilter}
        ORDER BY relevance
        LIMIT ? OFFSET ?
      `);

      // Escape special FTS5 characters and prepare query
      const safeQuery = this._escapeFtsQuery(query);
      const rows = stmt.all(safeQuery, limit, offset);

      return rows.map(row => ({
        ...this._rowToConversation(row),
        relevance: row.relevance
      }));
    } catch (err) {
      console.error(chalk.red(`⚠️ FTS5 search failed for query "${query}": ${err.message}`));
      console.error(chalk.gray('   Falling back to basic search. FTS index may need rebuilding.'));
      // Fallback to basic LIKE search
      return this.getConversations(options);
    }
  }

  /**
   * Search conversations with FTS5 and return snippets
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Array} Matching conversations with snippets and match counts
   */
  searchConversationsWithSnippets(query, options = {}) {
    const { limit = 50, offset = 0, includeSubagents = false } = options;

    if (!query || !query.trim()) {
      return [];
    }

    try {
      // Build subagent filter
      const subagentFilter = includeSubagents
        ? ''
        : 'AND (c.is_subagent = 0 OR c.is_subagent IS NULL)';

      // FTS5 query with snippet() and highlight() functions
      const stmt = this.db.prepare(`
        SELECT
          c.id, c.file_path, c.filename, c.project, c.message_count, c.file_size,
          c.last_modified, c.created, c.tokens_total, c.tokens_input, c.tokens_output,
          c.primary_model, c.indexed_at, c.is_subagent, c.parent_id,
          bm25(conversation_fts) as relevance,
          snippet(conversation_fts, 1, '{{MATCH}}', '{{/MATCH}}', '...', 20) as snippet
        FROM conversation_fts fts
        JOIN conversations c ON fts.conversation_id = c.id
        WHERE conversation_fts MATCH ? ${subagentFilter}
        ORDER BY relevance
        LIMIT ? OFFSET ?
      `);

      // Escape special FTS5 characters and prepare query
      const safeQuery = this._escapeFtsQuery(query);
      const rows = stmt.all(safeQuery, limit, offset);

      return rows.map(row => ({
        ...this._rowToConversation(row),
        relevance: row.relevance,
        snippet: row.snippet,
        searchTerm: query
      }));
    } catch (err) {
      console.error(chalk.red(`⚠️ FTS5 snippet search failed for query "${query}": ${err.message}`));
      console.error(chalk.gray('   Falling back to basic search without snippets.'));
      // Fallback to basic search without snippets
      return this.searchConversations(query, options);
    }
  }

  /**
   * Get conversation by ID
   * @param {string} id - Conversation ID
   * @returns {Object|null} Conversation object or null
   */
  getConversation(id) {
    const stmt = this.db.prepare(`
      SELECT * FROM conversations WHERE id = ?
    `);
    const row = stmt.get(id);
    return row ? this._rowToConversation(row) : null;
  }

  /**
   * Get total conversation count
   * @param {string} project - Optional project filter
   * @returns {number} Count
   */
  getConversationCount(project = null) {
    let sql = 'SELECT COUNT(*) as count FROM conversations';
    const params = [];

    if (project) {
      sql += ' WHERE project = ?';
      params.push(project);
    }

    const stmt = this.db.prepare(sql);
    return stmt.get(...params).count;
  }

  /**
   * Get unique projects
   * @returns {Array<string>} Project names
   */
  getProjects() {
    const stmt = this.db.prepare(`
      SELECT DISTINCT project FROM conversations
      WHERE project IS NOT NULL
      ORDER BY project
    `);
    return stmt.all().map(row => row.project);
  }

  /**
   * Get aggregated tool usage statistics
   * @returns {Object} Tool usage summary
   */
  getToolUsageStats() {
    const stmt = this.db.prepare(`
      SELECT tool_name, SUM(call_count) as total_calls, COUNT(DISTINCT conversation_id) as conversations
      FROM tool_usage
      GROUP BY tool_name
      ORDER BY total_calls DESC
    `);
    return stmt.all();
  }

  /**
   * Get summary statistics
   * @returns {Object} Summary data
   */
  getSummary() {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total_conversations,
        SUM(message_count) as total_messages,
        SUM(tokens_total) as total_tokens,
        SUM(file_size) as total_size,
        COUNT(DISTINCT project) as total_projects
      FROM conversations
    `).get();

    const recentActivity = this.db.prepare(`
      SELECT COUNT(*) as count FROM conversations
      WHERE last_modified > ?
    `).get(Date.now() - 24 * 60 * 60 * 1000); // Last 24 hours

    return {
      totalConversations: stats.total_conversations || 0,
      totalMessages: stats.total_messages || 0,
      totalTokens: stats.total_tokens || 0,
      totalSize: stats.total_size || 0,
      totalProjects: stats.total_projects || 0,
      activeToday: recentActivity.count || 0
    };
  }

  /**
   * Remove conversation from database
   * @param {string} id - Conversation ID
   */
  removeConversation(id) {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM conversation_fts WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM tool_usage WHERE conversation_id = ?').run(id);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    });
    transaction();
  }

  /**
   * Remove file from tracking (for deleted files)
   * @param {string} filePath - File path
   */
  removeFile(filePath) {
    const transaction = this.db.transaction(() => {
      const conv = this.db.prepare('SELECT id FROM conversations WHERE file_path = ?').get(filePath);
      if (conv) {
        // Clear parent_id references from any subagents that reference this conversation
        // This prevents orphaned references to non-existent parents
        const orphanedCount = this.db.prepare(
          'UPDATE conversations SET parent_id = NULL WHERE parent_id = ?'
        ).run(conv.id);
        if (orphanedCount.changes > 0) {
          console.log(chalk.gray(`   Cleared ${orphanedCount.changes} orphaned subagent reference(s)`));
        }

        // Inline the deletion to keep it atomic
        this.db.prepare('DELETE FROM conversation_fts WHERE conversation_id = ?').run(conv.id);
        this.db.prepare('DELETE FROM tool_usage WHERE conversation_id = ?').run(conv.id);
        this.db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
      }
      this.db.prepare('DELETE FROM file_index WHERE file_path = ?').run(filePath);
    });
    transaction();
  }

  /**
   * Get all indexed file paths
   * @returns {Set<string>} Set of file paths
   */
  getIndexedFilePaths() {
    const stmt = this.db.prepare('SELECT file_path FROM file_index');
    return new Set(stmt.all().map(row => row.file_path));
  }

  /**
   * Convert database row to conversation object
   * @private
   */
  _rowToConversation(row) {
    return {
      id: row.id,
      filePath: row.file_path,
      filename: row.filename,
      project: row.project,
      messageCount: row.message_count,
      fileSize: row.file_size,
      lastModified: new Date(row.last_modified),
      created: new Date(row.created),
      tokens: row.tokens_total,
      tokenUsage: {
        total: row.tokens_total,
        input: row.tokens_input,
        output: row.tokens_output
      },
      modelInfo: {
        primaryModel: row.primary_model
      },
      indexedAt: new Date(row.indexed_at),
      isSubagent: row.is_subagent === 1,
      parentId: row.parent_id || null
    };
  }

  /**
   * Escape special FTS5 query characters
   * @private
   */
  _escapeFtsQuery(query) {
    // Escape all FTS5 special characters and operators
    // FTS5 operators: AND OR NOT NEAR " ( ) * : ^ - +
    return query
      .replace(/[":()^*\-+]/g, ' ')  // Remove special chars
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')  // Remove boolean operators
      .replace(/\s+/g, ' ')
      .trim() || '*';  // Default to match-all if empty after escaping
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Vacuum database to reclaim space
   */
  vacuum() {
    this.db.exec('VACUUM');
  }

  /**
   * Resolve project names to use the canonical project root name
   *
   * This handles two cases:
   * 1. Conversations without cwd that fall back to encoded path names
   * 2. Subagents spawned from subdirectories (e.g., "cli-tool" instead of "claude-chats-monitor")
   *
   * The canonical name is determined by finding the shortest cwd that is a prefix
   * of all other cwds in the same encoded folder - this represents the project root.
   *
   * @returns {Object} { resolved: number, folders: number }
   */
  resolveEncodedProjectNames() {
    // Get all conversations with their cwds
    const allConversations = this.db.prepare(`
      SELECT id, file_path, project, cwd FROM conversations
    `).all();

    // Group conversations by their encoded folder
    const folderData = new Map(); // encodedFolder -> { conversations: [], cwds: Set }

    for (const conv of allConversations) {
      // Extract encoded folder from path
      const pathParts = conv.file_path.split('/');
      const projectsIdx = pathParts.indexOf('projects');
      if (projectsIdx === -1 || pathParts.length <= projectsIdx + 1) continue;

      const encodedFolder = pathParts[projectsIdx + 1];

      if (!folderData.has(encodedFolder)) {
        folderData.set(encodedFolder, { conversations: [], cwds: new Set() });
      }

      const data = folderData.get(encodedFolder);
      data.conversations.push(conv);
      if (conv.cwd) {
        data.cwds.add(conv.cwd);
      }
    }

    let resolvedCount = 0;
    let foldersResolved = 0;

    const updateStmt = this.db.prepare(`
      UPDATE conversations SET project = ? WHERE id = ?
    `);

    const updateFtsStmt = this.db.prepare(`
      UPDATE conversation_fts SET project = ? WHERE conversation_id = ?
    `);

    // For each folder, find the root cwd and normalize all project names
    const transaction = this.db.transaction(() => {
      for (const [encodedFolder, data] of folderData) {
        const cwdArray = Array.from(data.cwds);
        if (cwdArray.length === 0) continue;

        // Find the root cwd (shortest path that is a prefix of all others)
        // Sort by length, shortest first
        cwdArray.sort((a, b) => a.length - b.length);
        let rootCwd = cwdArray[0];

        // Verify it's actually a prefix of all others
        for (const cwd of cwdArray) {
          if (!cwd.startsWith(rootCwd)) {
            // Not a common prefix, fall back to using the shortest one anyway
            // This handles edge cases where cwds don't have a common root
            break;
          }
        }

        const canonicalName = path.basename(rootCwd);
        if (!canonicalName) continue;

        // Update all conversations in this folder to use the canonical name
        let folderUpdated = false;
        for (const conv of data.conversations) {
          if (conv.project !== canonicalName) {
            updateStmt.run(canonicalName, conv.id);
            updateFtsStmt.run(canonicalName, conv.id);
            resolvedCount++;
            folderUpdated = true;
          }
        }
        if (folderUpdated) foldersResolved++;
      }
    });

    transaction();

    return { resolved: resolvedCount, folders: foldersResolved };
  }
}

module.exports = DatabaseManager;
