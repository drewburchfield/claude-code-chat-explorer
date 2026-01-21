const chalk = require('chalk');
const path = require('path');
const os = require('os');
const DatabaseManager = require('./DatabaseManager');
const Indexer = require('./Indexer');

/**
 * DatabaseBackend - Integration layer between SQLite database and ChatsMobile
 *
 * This class wraps the database manager and indexer to provide a clean interface
 * for the chat server to use. It handles initialization, indexing, and provides
 * conversation data in the same format expected by the existing code.
 */
class DatabaseBackend {
  constructor(claudeDir, options = {}) {
    this.claudeDir = claudeDir || path.join(os.homedir(), '.claude');
    this.options = options;

    // Database path - in a data directory within claude folder
    // or custom path for Docker containers
    this.dbPath = options.dbPath ||
      process.env.CLAUDE_DB_PATH ||
      path.join(this.claudeDir, 'data', 'conversations.db');

    this.db = null;
    this.indexer = null;
    this.isInitialized = false;
  }

  /**
   * Initialize the database backend
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.isInitialized) return;

    console.log(chalk.yellow('📦 Initializing SQLite database backend...'));

    try {
      // Initialize database manager
      this.db = new DatabaseManager(this.dbPath);
      await this.db.initialize();

      // Initialize indexer
      this.indexer = new Indexer(this.db, this.claudeDir);

      // Run initial indexing
      await this.runIndex();

      this.isInitialized = true;
      console.log(chalk.green('✅ Database backend initialized'));

    } catch (err) {
      // Clean up database connection on error
      if (this.db) {
        try {
          this.db.close();
        } catch (closeErr) {
          // Ignore close errors during cleanup
        }
        this.db = null;
      }
      this.indexer = null;
      console.error(chalk.red('❌ Failed to initialize database backend:'), err.message);
      throw err;
    }
  }

  /**
   * Run indexing process (incremental - only changed files)
   * @returns {Promise<Object>} Indexing statistics
   */
  async runIndex() {
    if (!this.indexer) {
      throw new Error('Database not initialized');
    }
    return await this.indexer.runFullIndex();
  }

  /**
   * Get all conversations (for API responses)
   * Returns data in the same format expected by the existing frontend
   * @param {Object} options - Query options
   * @returns {Array} Array of conversation objects
   */
  getConversations(options = {}) {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const conversations = this.db.getConversations(options);

    // Transform to match expected format
    return conversations.map(conv => this._transformConversation(conv));
  }

  /**
   * Search conversations using full-text search
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Array} Matching conversations
   */
  searchConversations(query, options = {}) {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const conversations = this.db.searchConversations(query, options);
    return conversations.map(conv => this._transformConversation(conv));
  }

  /**
   * Search conversations with FTS5 and return snippets
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Array} Matching conversations with snippets
   */
  searchConversationsWithSnippets(query, options = {}) {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const conversations = this.db.searchConversationsWithSnippets(query, options);
    return conversations.map(conv => ({
      ...this._transformConversation(conv),
      snippet: conv.snippet,
      searchTerm: conv.searchTerm,
      relevance: conv.relevance
    }));
  }

  /**
   * Get a specific conversation by ID
   * @param {string} id - Conversation ID
   * @returns {Object|null} Conversation object
   */
  getConversation(id) {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const conv = this.db.getConversation(id);
    return conv ? this._transformConversation(conv) : null;
  }

  /**
   * Get summary statistics
   * @returns {Object} Summary data
   */
  getSummary() {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return this.db.getSummary();
  }

  /**
   * Get unique project names
   * @returns {Array<string>} Project names
   */
  getProjects() {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return this.db.getProjects();
  }

  /**
   * Get tool usage statistics
   * @returns {Array} Tool usage data
   */
  getToolUsageStats() {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return this.db.getToolUsageStats();
  }

  /**
   * Get total conversation count
   * @param {string} project - Optional project filter
   * @returns {number} Count
   */
  getConversationCount(project = null) {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    return this.db.getConversationCount(project);
  }

  /**
   * Re-index a single file (for file watcher updates)
   * @param {string} filePath - Path to JSONL file
   */
  async indexFile(filePath) {
    if (!this.indexer) {
      throw new Error('Database not initialized');
    }

    return await this.indexer.indexSingleFile(filePath);
  }

  /**
   * Remove a file from the index (for deleted files)
   * @param {string} filePath - Path to file
   */
  removeFile(filePath) {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    this.db.removeFile(filePath);
  }

  /**
   * Transform database conversation object to expected format
   * Matches the format produced by ConversationAnalyzer.loadConversations()
   * @private
   */
  _transformConversation(conv) {
    return {
      id: conv.id,
      filename: conv.filename,
      filePath: conv.filePath,
      messageCount: conv.messageCount,
      fileSize: conv.fileSize,
      lastModified: conv.lastModified,
      created: conv.created,
      tokens: conv.tokens,
      tokenUsage: conv.tokenUsage || {
        total: conv.tokens,
        input: conv.tokenUsage?.input || 0,
        output: conv.tokenUsage?.output || 0
      },
      modelInfo: conv.modelInfo || {
        primaryModel: conv.modelInfo?.primaryModel || 'Unknown'
      },
      project: conv.project || 'Unknown',
      // Status fields - will be computed dynamically when needed
      status: 'idle',
      conversationState: 'idle',
      statusSquares: [],
      // Tool usage - stored separately in database
      toolUsage: {
        total: 0,
        tools: {}
      },
      // Subagent hierarchy fields
      isSubagent: conv.isSubagent || false,
      parentId: conv.parentId || null
    };
  }

  /**
   * Close the database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.isInitialized = false;
  }

  /**
   * Vacuum database to reclaim space
   */
  vacuum() {
    if (this.db) {
      this.db.vacuum();
    }
  }
}

module.exports = DatabaseBackend;
