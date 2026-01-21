const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');

/**
 * Indexer - Efficiently indexes JSONL conversation files into SQLite database
 *
 * Features:
 * - Incremental indexing: only processes changed files
 * - Streaming parsing: never loads entire file into memory
 * - Batched inserts: reduces SQLite transaction overhead
 * - Progress reporting: shows indexing progress
 */
class Indexer {
  constructor(databaseManager, claudeDir) {
    this.db = databaseManager;
    this.claudeDir = claudeDir;
    this.projectsDir = path.join(claudeDir, 'projects');
  }

  /**
   * Run full indexing process
   * @returns {Promise<Object>} Indexing statistics
   */
  async runFullIndex() {
    console.log(chalk.yellow('📊 Starting conversation indexing...'));
    const startTime = Date.now();

    const stats = {
      filesScanned: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      filesRemoved: 0,
      errors: 0
    };

    try {
      // Get all JSONL files
      const files = await this._findJsonlFiles(this.projectsDir);
      stats.filesScanned = files.length;
      console.log(chalk.gray(`Found ${files.length} JSONL files to process`));

      // Get currently indexed files to detect deletions
      const indexedPaths = this.db.getIndexedFilePaths();

      // Process files in batches for progress reporting
      const batchSize = 50;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);

        for (const filePath of batch) {
          try {
            const fileStats = await fs.stat(filePath);
            const mtime = fileStats.mtime.getTime();
            const size = fileStats.size;

            // Remove from tracked set (remaining = deleted files)
            indexedPaths.delete(filePath);

            // Check if file needs indexing
            if (!this.db.needsIndexing(filePath, mtime, size)) {
              stats.filesSkipped++;
              continue;
            }

            // Index the file
            await this._indexFile(filePath, fileStats);
            stats.filesIndexed++;

          } catch (err) {
            console.warn(chalk.yellow(`Warning: Could not process ${path.basename(filePath)}: ${err.message}`));
            stats.errors++;
          }
        }

        // Progress update
        const processed = Math.min(i + batchSize, files.length);
        const percent = Math.round((processed / files.length) * 100);
        process.stdout.write(`\r${chalk.cyan('⏳')} Indexing progress: ${percent}% (${processed}/${files.length})`);
      }

      console.log(); // New line after progress

      // Remove deleted files from database
      for (const deletedPath of indexedPaths) {
        this.db.removeFile(deletedPath);
        stats.filesRemoved++;
      }

      // Resolve any encoded project names using proper names from the same folder
      const resolveResult = this.db.resolveEncodedProjectNames();
      if (resolveResult.resolved > 0) {
        console.log(chalk.cyan(`🔗 Resolved ${resolveResult.resolved} encoded project names across ${resolveResult.folders} folders`));
        stats.projectNamesResolved = resolveResult.resolved;
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(chalk.green(`✅ Indexing complete in ${duration}s`));
      console.log(chalk.gray(`   Indexed: ${stats.filesIndexed}, Skipped: ${stats.filesSkipped}, Removed: ${stats.filesRemoved}, Errors: ${stats.errors}`));

      return stats;

    } catch (err) {
      console.error(chalk.red('Indexing failed:'), err.message);
      throw err;
    }
  }

  /**
   * Index a single file (for real-time updates)
   * @param {string} filePath - Path to JSONL file
   */
  async indexSingleFile(filePath) {
    try {
      const fileStats = await fs.stat(filePath);
      await this._indexFile(filePath, fileStats);
      return { success: true };
    } catch (err) {
      const errorInfo = {
        success: false,
        filePath,
        error: err.message,
        code: err.code || 'UNKNOWN'
      };
      console.warn(chalk.yellow(`Could not index ${path.basename(filePath)}: ${err.message} (${errorInfo.code})`));
      return errorInfo;
    }
  }

  /**
   * Internal method to index a single file
   * @private
   */
  async _indexFile(filePath, fileStats) {
    const filename = path.basename(filePath);

    // Detect subagent from path structure first (needed for ID generation)
    // Subagent paths: ~/.claude/projects/{encoded-path}/{parent-id}/subagents/agent-{id}.jsonl
    const { isSubagent, parentId } = this._detectSubagent(filePath);

    // Generate unique ID:
    // - Regular sessions: just the filename (already a UUID)
    // - Subagents: parentId_filename (since same short agent ID can exist under different parents)
    const baseId = filename.replace('.jsonl', '');
    const id = isSubagent && parentId ? `${parentId}_${baseId}` : baseId;

    // Parse file with streaming to avoid memory issues
    const parseResult = await this._parseJsonlStreaming(filePath);

    // Extract project name: prefer cwd from file content, fallback to path decoding
    // Note: subagents spawned from subdirectories will get the subdirectory name initially
    // (e.g., "cli-tool" instead of "claude-chats-monitor"), but resolveEncodedProjectNames()
    // will normalize these after indexing by finding the project root name
    let project;
    if (parseResult.cwd) {
      // Use the actual working directory from the conversation
      project = path.basename(parseResult.cwd);
    } else {
      // Fallback to path-based extraction
      project = this._extractProjectFromPath(filePath);
    }

    // Build conversation object
    const conversation = {
      id,
      filePath,
      filename,
      project,
      cwd: parseResult.cwd,  // Store original cwd for project name resolution
      messageCount: parseResult.messageCount,
      fileSize: fileStats.size,
      lastModified: fileStats.mtime,
      created: fileStats.birthtime,
      tokenUsage: parseResult.tokenUsage,
      modelInfo: parseResult.modelInfo,
      toolUsage: parseResult.toolUsage,
      isSubagent,
      parentId
    };

    // Insert into database
    this.db.upsertConversation(conversation, parseResult.searchableContent);
  }

  /**
   * Parse JSONL file using streaming to avoid memory issues
   * @private
   */
  async _parseJsonlStreaming(filePath) {
    return new Promise((resolve, reject) => {
      const result = {
        messageCount: 0,
        tokenUsage: { total: 0, input: 0, output: 0 },
        modelInfo: { primaryModel: null, models: {} },
        toolUsage: { total: 0, tools: {} },
        searchableContent: '',
        cwd: null  // Extract working directory for project name
      };

      const contentParts = [];
      const modelCounts = {};
      let lineCount = 0;
      let parseErrorCount = 0;
      const filename = path.basename(filePath);

      const readStream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({
        input: readStream,
        crlfDelay: Infinity
      });

      // Cleanup function to properly close resources
      const cleanup = () => {
        rl.close();
        readStream.destroy();
      };

      rl.on('line', (line) => {
        lineCount++;
        if (!line.trim()) return;

        try {
          const item = JSON.parse(line);

          // Extract cwd - keep scanning until we find it
          // Files may start with summary entries from context compaction, so we can't limit to first N lines
          if (!result.cwd) {
            if (item.cwd) {
              result.cwd = item.cwd;
            } else if (item.message && item.message.cwd) {
              result.cwd = item.message.cwd;
            }
          }

          // Only count user/assistant messages
          if (item.message && (item.type === 'assistant' || item.type === 'user')) {
            result.messageCount++;

            // Extract searchable content
            const content = this._extractTextContent(item.message.content);
            if (content) {
              // Limit content per message to prevent huge FTS entries
              contentParts.push(content.slice(0, 2000));
            }

            // Track token usage from assistant messages
            if (item.type === 'assistant' && item.message.usage) {
              const usage = item.message.usage;
              result.tokenUsage.input += usage.input_tokens || 0;
              result.tokenUsage.output += usage.output_tokens || 0;
            }

            // Track model usage
            if (item.message.model) {
              const model = item.message.model;
              modelCounts[model] = (modelCounts[model] || 0) + 1;
            }

            // Track tool usage from assistant messages
            if (item.type === 'assistant' && item.message.content) {
              const tools = this._extractToolNames(item.message.content);
              for (const tool of tools) {
                result.toolUsage.tools[tool] = (result.toolUsage.tools[tool] || 0) + 1;
                result.toolUsage.total++;
              }
            }
          }
        } catch (parseErr) {
          // Log parse errors with context (limit to avoid spam)
          parseErrorCount++;
          if (parseErrorCount <= 3) {
            console.warn(chalk.yellow(`⚠️ Invalid JSON at line ${lineCount} in ${filename}: ${parseErr.message}`));
          } else if (parseErrorCount === 4) {
            console.warn(chalk.yellow(`⚠️ Additional parse errors suppressed for ${filename}`));
          }
        }
      });

      rl.on('close', () => {
        // Calculate total tokens
        result.tokenUsage.total = result.tokenUsage.input + result.tokenUsage.output;

        // Find primary model (most used)
        let maxCount = 0;
        for (const [model, count] of Object.entries(modelCounts)) {
          if (count > maxCount) {
            maxCount = count;
            result.modelInfo.primaryModel = model;
          }
        }
        result.modelInfo.models = modelCounts;

        // Join searchable content (limit total size)
        result.searchableContent = contentParts.join('\n').slice(0, 100000);

        resolve(result);
      });

      rl.on('error', (err) => {
        cleanup();
        reject(err);
      });

      readStream.on('error', (err) => {
        cleanup();
        reject(err);
      });
    });
  }

  /**
   * Extract text content from message content (handles various formats)
   * @private
   */
  _extractTextContent(content) {
    if (!content) return '';

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .filter(block => block.type === 'text')
        .map(block => block.text || '')
        .join('\n');
    }

    if (content.type === 'text') {
      return content.text || '';
    }

    return '';
  }

  /**
   * Extract tool names from message content
   * @private
   */
  _extractToolNames(content) {
    const tools = [];

    if (!content) return tools;

    const blocks = Array.isArray(content) ? content : [content];

    for (const block of blocks) {
      if (block.type === 'tool_use' && block.name) {
        tools.push(block.name);
      }
    }

    return tools;
  }

  /**
   * Extract project name from file path
   * @private
   *
   * Note: This is a fallback when cwd is not found in the JSONL file.
   * Claude encodes paths by replacing / with -, which is lossy for directories
   * containing dashes (e.g., master-mcp becomes master/mcp when decoded).
   *
   * The cwd extraction (now scanning full file) should handle most cases.
   * This fallback returns the encoded folder name for identification.
   */
  _extractProjectFromPath(filePath) {
    // Path format: ~/.claude/projects/-Users-username-project-name/session.jsonl
    // Or subagent: ~/.claude/projects/-Users-username-project-name/{parent-id}/subagents/agent-{id}.jsonl
    const relativePath = filePath.replace(this.projectsDir, '');
    const parts = relativePath.split(path.sep).filter(Boolean);

    if (parts.length > 0) {
      // The first part is the encoded project path (e.g., -Users-john-dev-my-project)
      // We can't reliably decode it because dashes in directory names become indistinguishable
      // from path separators.
      const encoded = parts[0];

      // Return the encoded name with leading dash removed for slightly cleaner display
      // It's not pretty but it's accurate and unique
      if (encoded.startsWith('-')) {
        return encoded.substring(1);
      }
      return encoded;
    }

    return 'Unknown';
  }

  /**
   * Detect if a file is a subagent and extract parent ID
   * Subagent paths: ~/.claude/projects/{encoded-path}/{parent-id}/subagents/agent-{id}.jsonl
   * @private
   * @param {string} filePath - Path to JSONL file
   * @returns {Object} { isSubagent: boolean, parentId: string|null }
   */
  _detectSubagent(filePath) {
    const pathParts = filePath.split(path.sep);
    const subagentIdx = pathParts.indexOf('subagents');

    if (subagentIdx !== -1 && subagentIdx > 0) {
      // The directory before 'subagents' is the parent conversation ID
      const parentId = pathParts[subagentIdx - 1];

      // Validate parent ID looks like a UUID (basic check)
      if (!/^[a-f0-9-]{8,}$/i.test(parentId)) {
        console.warn(chalk.yellow(`⚠️ Subagent detected but parent ID looks invalid: ${parentId}`));
      }

      return { isSubagent: true, parentId };
    }

    return { isSubagent: false, parentId: null };
  }

  /**
   * Find all JSONL files recursively
   * @private
   */
  async _findJsonlFiles(dir) {
    const files = [];

    const exists = await fs.pathExists(dir);
    if (!exists) return files;

    const items = await fs.readdir(dir);

    for (const item of items) {
      const itemPath = path.join(dir, item);

      try {
        const stats = await fs.stat(itemPath);

        if (stats.isDirectory()) {
          const subFiles = await this._findJsonlFiles(itemPath);
          files.push(...subFiles);
        } else if (item.endsWith('.jsonl')) {
          files.push(itemPath);
        }
      } catch (err) {
        // Log access errors to help users diagnose missing conversations
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          console.warn(chalk.yellow(`⚠️ Permission denied: ${itemPath}`));
        } else if (err.code !== 'ENOENT') {
          // ENOENT is expected for race conditions, other errors are noteworthy
          console.warn(chalk.yellow(`⚠️ Could not access ${itemPath}: ${err.message}`));
        }
      }
    }

    return files;
  }
}

module.exports = Indexer;
