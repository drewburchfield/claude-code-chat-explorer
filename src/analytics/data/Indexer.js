const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');
const { fileChangeFromTool } = require('../core/ToolTaxonomy');
const { classifyAgentWorktree } = require('../core/WorktreeClassifier');

// Per-block safety ceiling for FTS content. We no longer truncate at 2000
// chars (that lost recall vs the on-disk text); the only cap is this generous
// ceiling, which exists solely to stop a single pathological block (e.g. a
// base64 blob that slipped past the image filter) from bloating the index.
const BLOCK_CHAR_CAP = 256 * 1024;

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
      let files = await this._findJsonlFiles(this.projectsDir);
      stats.filesScanned = files.length;
      console.log(chalk.gray(`Found ${files.length} JSONL files to process`));

      // Newest first. On a large backlog the tool becomes useful in seconds
      // instead of after the whole corpus, because the conversations a user
      // actually wants are the ones they touched most recently. Unchanged
      // files are skipped cheaply either way, so this only reorders real work.
      // stat failures sort last rather than aborting the pass.
      const mtimes = new Map();
      await Promise.all(files.map(async (f) => {
        try { mtimes.set(f, (await fs.stat(f)).mtime.getTime()); }
        catch { mtimes.set(f, 0); }
      }));
      files = files.sort((a, b) => (mtimes.get(b) || 0) - (mtimes.get(a) || 0));

      // Get currently indexed files to detect deletions. Union file_index with
      // the conversations table so orphans are still detected when file_index
      // was cleared by a content-version migration (otherwise a conversation
      // whose file was deleted before the upgrade would linger as a ghost FTS
      // result, since an empty file_index hides it from this cleanup pass).
      const indexedPaths = this.db.getIndexedFilePaths();
      for (const p of this.db.getConversationFilePaths()) {
        indexedPaths.add(p);
      }

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

            // Hand the event loop back after every file we actually indexed.
            // _indexFile is CPU-bound and synchronous inside (JSON.parse per
            // line plus better-sqlite3 writes), so without this the HTTP server
            // sharing this loop is starved: a request needs several loop turns
            // to complete and each one queues behind another file. Measured on
            // a ~4 GB store, serving the static index page took 27 s during a
            // reindex. setImmediate runs pending I/O callbacks before the next
            // file, which costs microseconds per file and keeps the UI usable.
            // Only on the indexed path: skipped files are cheap and already
            // yield via the awaited fs.stat above.
            await new Promise(resolve => setImmediate(resolve));

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

      // Merge FTS segments after a pass that actually wrote something. Each
      // re-index is a delete+reinsert and contentless_delete accumulates
      // tombstones, so without this the segment count grows and queries drift
      // slower over time. Skipped when nothing changed, so the common no-op
      // pass stays a no-op.
      if ((stats.filesIndexed > 0 || stats.filesRemoved > 0) &&
          typeof this.db.optimizeSearchIndex === 'function') {
        this.db.optimizeSearchIndex();
      }

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

    // Agent worktree sessions (Agent tool isolation, EnterWorktree, Cyrus)
    // get their own top-level transcript directory keyed by the worktree cwd
    // and carry no parent linkage, so each one masqueraded as a fake project
    // in the main list. Classify by cwd: mark as a subagent (every default
    // list/search/rollup already excludes those) and attribute the session
    // to the owning repo. parentId stays null: the parent session id is
    // genuinely not recorded anywhere in the child transcript.
    const worktree = classifyAgentWorktree(parseResult.cwd);
    const isWorktreeAgent = !!worktree;
    if (worktree?.owningProject) {
      project = worktree.owningProject;
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
      fileChanges: parseResult.fileChanges,
      isSubagent: isSubagent || isWorktreeAgent,
      isWorktreeAgent,
      parentId
    };

    // Insert into database
    this.db.upsertConversation(conversation, parseResult.searchableContent, parseResult.messages);
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
        toolUsage: { total: 0, tools: {}, errors: {} },
        fileChanges: [],  // extracted from edit-tool inputs (ToolTaxonomy)
        searchableContent: '',
        messages: [],   // per-message records for role/tool-granular FTS
        cwd: null  // Extract working directory for project name
      };

      const contentParts = [];
      const messageRecords = [];
      // tool_use.id -> tool name, so a later tool_result's is_error can be
      // attributed to the right tool. Correlation is by id, never by array
      // order: one user message can carry several tool_result blocks.
      const toolUseNames = new Map();
      let msgSeq = 0;
      let fcSeq = 0;
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

            // Extract searchable content. No per-message cap: search must
            // match the on-disk text. The only bound is the 256KB-per-block
            // safety ceiling inside _extractTextContent.
            const content = this._extractTextContent(item.message.content);
            if (content) {
              contentParts.push(content);
            }

            // Per-message records (role/tool-granular). text+thinking under the
            // message's own role; tool_use/tool_result as separate 'tool' rows.
            // src_line is the 1-based transcript line, recorded at parse time
            // because it cannot be reconstructed later.
            for (const rec of this._extractMessageRecords(item.message.content, item.type)) {
              messageRecords.push({ seq: msgSeq++, src_line: lineCount, ...rec });
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

            // Track tool usage from assistant messages: counts, the id map
            // for error correlation, and file changes from edit-tool inputs.
            if (item.type === 'assistant' && item.message.content) {
              const blocks = Array.isArray(item.message.content)
                ? item.message.content : [item.message.content];
              for (const block of blocks) {
                if (!block || block.type !== 'tool_use' || !block.name) continue;
                result.toolUsage.tools[block.name] = (result.toolUsage.tools[block.name] || 0) + 1;
                result.toolUsage.total++;
                if (block.id) toolUseNames.set(block.id, block.name);
                const fc = fileChangeFromTool(block.name, block.input);
                if (fc) result.fileChanges.push({ seq: fcSeq++, src_line: lineCount, ...fc });
              }
            }

            // Attribute tool_result errors to their tool via tool_use_id.
            if (item.type === 'user' && Array.isArray(item.message.content)) {
              for (const block of item.message.content) {
                if (!block || block.type !== 'tool_result' || !block.is_error) continue;
                const tool = block.tool_use_id ? toolUseNames.get(block.tool_use_id) : null;
                if (tool) {
                  result.toolUsage.errors[tool] = (result.toolUsage.errors[tool] || 0) + 1;
                }
              }
            }
          } else if (item.type === 'system' && typeof item.content === 'string') {
            // System reminders and hook output (top-level string content, no
            // message wrapper) often quote settings, file paths, and tokens
            // that grep finds on disk. Index them so search matches; they are
            // not counted as messages.
            contentParts.push(`[SYSTEM] ${item.content}`);
            messageRecords.push({ seq: msgSeq++, role: 'system', tool_name: null, text: `[SYSTEM] ${item.content}` });
          } else if (item.type === 'summary' && typeof item.summary === 'string') {
            // Compaction summary entries that prefix resumed sessions.
            contentParts.push(`[SUMMARY] ${item.summary}`);
            messageRecords.push({ seq: msgSeq++, role: 'system', tool_name: null, text: `[SUMMARY] ${item.summary}` });
          } else if (item.type === 'queue-operation' && typeof item.content === 'string') {
            // Queued user messages (top-level string content) are genuine
            // user-authored text that should be searchable.
            contentParts.push(`[QUEUED] ${item.content}`);
            messageRecords.push({ seq: msgSeq++, role: 'user', tool_name: null, text: `[QUEUED] ${item.content}` });
          } else if (item.type === 'attachment' && item.attachment) {
            // Pasted/attached payloads (e.g. file diffs, edited text) carry
            // real content the user pasted in. Index the payload text.
            const attachText = this._stringifyToolPayload(item.attachment).slice(0, BLOCK_CHAR_CAP);
            if (attachText) {
              contentParts.push(`[ATTACHMENT] ${attachText}`);
              messageRecords.push({ seq: msgSeq++, role: 'user', tool_name: null, text: `[ATTACHMENT] ${attachText}` });
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

        // Join searchable content. No total-size cap: the index mirrors the
        // on-disk text. Per-block 256KB ceiling still guards pathological blobs.
        result.searchableContent = contentParts.join('\n');
        result.messages = messageRecords;

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
   * Extract searchable text from a message content payload.
   *
   * Pulls in four kinds of block:
   *   - `text` blocks verbatim
   *   - `thinking` blocks as `[THINKING] <reasoning>`, so a search for a
   *     token that only appeared in assistant reasoning hits the session
   *   - `tool_use` blocks as `[TOOL:<name>] <stringified-input>`, so a
   *     search for a Bash command line or a file path passed to Read
   *     hits the session that ran it
   *   - `tool_result` blocks as `[TOOL_RESULT] <text>`, so a search
   *     for grep output or a unique token in stdout hits the session
   *
   * The marker tags also let search snippets disambiguate matches at
   * the consumer end without us shipping a separate columns-per-kind
   * schema (FTS5 virtual tables can't be ALTERed in place, so the
   * unified-content approach lets us evolve coverage without churning
   * the migration story every release).
   *
   * @private
   */
  _extractTextContent(content) {
    if (!content) return '';

    if (typeof content === 'string') {
      return content;
    }

    const blocks = Array.isArray(content) ? content : [content];
    const parts = [];

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      } else if (block.type === 'thinking' && block.thinking) {
        // Index assistant reasoning so a search for a token that only
        // appeared in a thinking block still finds the session.
        parts.push(`[THINKING] ${block.thinking}`);
      } else if (block.type === 'tool_use') {
        const name = block.name || 'unknown';
        // Cap only at the 256KB safety ceiling so realistic tool inputs
        // (file paths, commands, payloads) match on disk.
        const inputText = this._stringifyToolPayload(block.input).slice(0, BLOCK_CHAR_CAP);
        parts.push(`[TOOL:${name}] ${inputText}`);
      } else if (block.type === 'tool_result') {
        const resultText = this._stringifyToolPayload(block.content).slice(0, BLOCK_CHAR_CAP);
        parts.push(`[TOOL_RESULT] ${resultText}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Extract per-message records for role/tool-granular FTS. Text and thinking
   * blocks become one record under the message's own role (`baseRole`); each
   * tool_use / tool_result block becomes a separate `tool` record (with
   * tool_name for tool_use). Mirrors _extractTextContent's content selection.
   * @param {*} content - message content (string or block array)
   * @param {string} baseRole - 'user' | 'assistant'
   * @returns {Array<{role:string, tool_name:?string, text:string}>}
   * @private
   */
  _extractMessageRecords(content, baseRole) {
    if (!content) return [];
    if (typeof content === 'string') {
      return content.trim() ? [{ role: baseRole, tool_name: null, text: content }] : [];
    }
    const blocks = Array.isArray(content) ? content : [content];
    const records = [];
    const textParts = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'thinking' && block.thinking) {
        textParts.push(`[THINKING] ${block.thinking}`);
      } else if (block.type === 'tool_use') {
        const name = block.name || 'unknown';
        const inputText = this._stringifyToolPayload(block.input).slice(0, BLOCK_CHAR_CAP);
        records.push({ role: 'tool', tool_name: name, text: `[TOOL:${name}] ${inputText}` });
      } else if (block.type === 'tool_result') {
        const resultText = this._stringifyToolPayload(block.content).slice(0, BLOCK_CHAR_CAP);
        records.push({ role: 'tool', tool_name: null, text: `[TOOL_RESULT] ${resultText}` });
      }
    }
    if (textParts.length) {
      records.unshift({ role: baseRole, tool_name: null, text: textParts.join('\n') });
    }
    return records;
  }

  /**
   * Flatten a tool input/result payload (object, array of blocks, or
   * primitive) to a single search-friendly string. Tool results in
   * particular can be either a plain string or an array of `text` and
   * `image` content blocks; we keep the text and skip the image bytes.
   * @private
   */
  _stringifyToolPayload(payload) {
    if (payload == null) return '';
    if (typeof payload === 'string') return payload;

    if (Array.isArray(payload)) {
      const lines = [];
      for (const item of payload) {
        if (typeof item === 'string') {
          lines.push(item);
        } else if (item && typeof item === 'object') {
          if (item.type === 'text' && item.text) lines.push(item.text);
          else if (item.type === 'image') lines.push('[image]');
          else lines.push(this._stringifyToolPayload(item));
        }
      }
      return lines.join('\n');
    }

    if (typeof payload === 'object') {
      try {
        return JSON.stringify(payload);
      } catch (err) {
        return '';
      }
    }

    return String(payload);
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
