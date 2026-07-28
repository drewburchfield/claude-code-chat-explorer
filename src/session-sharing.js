const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Hosts permitted as session-clone sources. Anything else is rejected before
// we touch the network. Keeping this list short and explicit prevents the
// import path from being used to pull arbitrary content into ~/.claude.
const ALLOWED_CLONE_HOSTS = new Set([
  'x0.at',
  'transfer.sh',
  'file.io',
  '0x0.st',
]);

const DOWNLOAD_TIMEOUT_MS = 15000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB
const MAX_CLONE_REDIRECTS = 4;

/**
 * SessionSharing - Handles exporting Claude Code sessions as downloadable context
 */
class SessionSharing {
  constructor(conversationAnalyzer) {
    this.conversationAnalyzer = conversationAnalyzer;
  }

  /**
   * Export conversation session as downloadable markdown file
   * @param {string} conversationId - Conversation ID to export
   * @param {Object} conversationData - Full conversation data object
   * @param {Object} options - Export options (messageLimit, etc.)
   * @returns {Promise<Object>} Export result with markdown content and filename
   */
  async exportSessionAsMarkdown(conversationId, conversationData, options = {}) {
    console.log(chalk.blue(`📥 Preparing session ${conversationId} for download...`));

    try {
      // 1. Get conversation messages
      const allMessages = await this.conversationAnalyzer.getParsedConversation(conversationData.filePath);

      // Limit messages to avoid large file sizes (default: last 100 messages)
      const messageLimit = options.messageLimit || 100;
      const messages = allMessages.slice(-messageLimit);

      // 2. Convert to markdown format
      const markdown = this.convertToMarkdown(messages, conversationData, {
        messageCount: messages.length,
        totalMessageCount: allMessages.length,
        wasLimited: allMessages.length > messageLimit
      });

      // 3. Generate filename
      const projectName = (conversationData.project || 'session').replace(/[^a-zA-Z0-9-_]/g, '-');
      const date = new Date().toISOString().split('T')[0];
      const filename = `claude-context-${projectName}-${date}.md`;

      console.log(chalk.green(`✅ Session exported successfully!`));
      console.log(chalk.gray(`📊 Exported ${messages.length} messages`));

      return {
        success: true,
        markdown,
        filename,
        messageCount: messages.length,
        totalMessageCount: allMessages.length,
        wasLimited: allMessages.length > messageLimit
      };
    } catch (error) {
      console.error(chalk.red('❌ Failed to export session:'), error.message);
      throw error;
    }
  }

  /**
   * Convert conversation messages to markdown format optimized for Claude Code
   * @param {Array} messages - Parsed conversation messages
   * @param {Object} conversationData - Conversation metadata
   * @param {Object} stats - Export statistics
   * @returns {string} Markdown formatted content
   */
  convertToMarkdown(messages, conversationData, stats) {
    const lines = [];

    // Header for Claude Code
    lines.push('# Previous Conversation Context\n');
    lines.push('> **Note to Claude Code**: This file contains the complete conversation history from a previous session. Read and understand this context to continue helping the user with their task.\n');
    lines.push(`**Project:** ${conversationData.project || 'Unknown'}`);
    lines.push(`**Date:** ${new Date().toISOString().split('T')[0]}`);
    lines.push(`**Messages in this export:** ${stats.messageCount}${stats.wasLimited ? ` (most recent from a total of ${stats.totalMessageCount})` : ''}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Conversation
    lines.push('## 💬 Conversation History\n');

    messages.forEach((msg, index) => {
      const role = msg.role === 'user' ? '👤 User' : '🤖 Assistant';
      const timestamp = new Date(msg.timestamp).toLocaleString();

      lines.push(`### Message ${index + 1}: ${role}`);
      lines.push(`*${timestamp}*\n`);

      // Extract text content from message
      if (Array.isArray(msg.content)) {
        msg.content.forEach(block => {
          if (block.type === 'text') {
            lines.push(block.text);
          } else if (block.type === 'tool_use') {
            lines.push(`\`\`\`${block.name || 'tool'}`);
            lines.push(JSON.stringify(block.input || {}, null, 2));
            lines.push('```');
          } else if (block.type === 'tool_result') {
            lines.push('**Tool Result:**');
            lines.push('```');
            lines.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2));
            lines.push('```');
          }
        });
      } else if (typeof msg.content === 'string') {
        lines.push(msg.content);
      }

      lines.push('');
      lines.push('---');
      lines.push('');
    });

    // Footer
    lines.push('\n---');
    lines.push('');
    lines.push('*Generated by Claude Chats Monitor*');

    return lines.join('\n');
  }

  /**
   * Export session data to standardized format
   * @param {string} conversationId - Conversation ID
   * @param {Object} conversationData - Conversation metadata
   * @param {Object} options - Export options
   * @returns {Promise<Object>} Exported session object
   */
  async exportSessionData(conversationId, conversationData, options = {}) {
    // Get all messages from the conversation
    const allMessages = await this.conversationAnalyzer.getParsedConversation(conversationData.filePath);

    // Limit messages to avoid large file sizes (default: last 100 messages)
    const messageLimit = options.messageLimit || 100;
    const messages = allMessages.slice(-messageLimit);

    // Convert parsed messages back to JSONL format (original Claude Code format)
    const jsonlMessages = messages.map(msg => {
      // Reconstruct original JSONL entry format
      const entry = {
        uuid: msg.uuid || msg.id,
        type: msg.role === 'assistant' ? 'assistant' : 'user',
        timestamp: msg.timestamp.toISOString(),
        message: {
          id: msg.id,
          role: msg.role,
          content: msg.content
        }
      };

      // Add model info for assistant messages
      if (msg.model) {
        entry.message.model = msg.model;
      }

      // Add usage info
      if (msg.usage) {
        entry.message.usage = msg.usage;
      }

      // Add compact summary flag if present
      if (msg.isCompactSummary) {
        entry.isCompactSummary = true;
      }

      return entry;
    });

    // Create export package
    const exportData = {
      version: '1.0.0',
      exported_at: new Date().toISOString(),
      conversation: {
        id: conversationId,
        project: conversationData.project || 'shared-session',
        created: conversationData.created,
        lastModified: conversationData.lastModified,
        messageCount: messages.length,
        totalMessageCount: allMessages.length,
        wasLimited: allMessages.length > messageLimit,
        tokens: conversationData.tokens,
        model: conversationData.modelInfo?.primaryModel || 'claude-sonnet-4-5-20250929'
      },
      messages: jsonlMessages,
      metadata: {
        exportTool: 'claude-chats-monitor',
        exportVersion: require('../package.json').version || '1.0.0',
        messageLimit: messageLimit,
        description: 'Claude Code session export'
      }
    };

    // Log information about exported messages
    if (allMessages.length > messageLimit) {
      console.log(chalk.yellow(`⚠️  Session has ${allMessages.length} messages, exporting last ${messageLimit} messages`));
    } else {
      console.log(chalk.gray(`📊 Exporting ${messages.length} messages`));
    }

    return exportData;
  }

  /**
   * Clone a session from a shared URL
   * Downloads the session and places it in the correct Claude Code location
   * @param {string} url - URL to download session from
   * @param {Object} options - Clone options
   * @returns {Promise<Object>} Result with session path
   */
  async cloneSession(url, options = {}) {
    console.log(chalk.blue(`📥 Downloading session from ${url}...`));

    try {
      // 1. Download session data
      const sessionData = await this.downloadSession(url);

      // 2. Validate session data
      this.validateSessionData(sessionData);

      console.log(chalk.green(`✅ Session downloaded successfully`));
      console.log(chalk.gray(`📊 Project: ${sessionData.conversation.project}`));
      console.log(chalk.gray(`💬 Messages: ${sessionData.conversation.messageCount}`));
      console.log(chalk.gray(`🤖 Model: ${sessionData.conversation.model}`));

      // 3. Install session in Claude Code directory
      const installResult = await this.installSession(sessionData, options);

      console.log(chalk.green(`\n✅ Session installed successfully!`));
      console.log(chalk.cyan(`📂 Location: ${installResult.sessionPath}`));

      // Show resume command (only conversation ID needed)
      const resumeCommand = `claude --resume ${installResult.conversationId}`;
      console.log(chalk.yellow(`\n💡 To continue this conversation, run:`));
      console.log(chalk.white(`\n   ${resumeCommand}\n`));
      console.log(chalk.gray(`   Or open Claude Code to see it in your sessions list`));

      return installResult;
    } catch (error) {
      console.error(chalk.red('❌ Failed to clone session:'), error.message);
      throw error;
    }
  }

  /**
   * Validate a URL is acceptable as a session-clone source. Throws on
   * invalid input. Pure function, no I/O.
   * @param {string} url
   * @returns {URL} A parsed URL object ready for fetch().
   */
  validateCloneUrl(url) {
    if (typeof url !== 'string' || url.trim() === '') {
      throw new Error('A clone URL is required');
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Clone URL is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported scheme: ${parsed.protocol}`);
    }
    // Exact match only. Subdomains of the allowed hosts are not implicitly
    // trusted: if a specific subdomain ever needs to be permitted, add it to
    // ALLOWED_CLONE_HOSTS by name.
    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED_CLONE_HOSTS.has(host)) {
      throw new Error(`Host not in clone allowlist: ${parsed.hostname}`);
    }
    return parsed;
  }

  /**
   * Download session data from a clone URL using native fetch with an
   * allowlist of hosts, a hard timeout, and a max-body cap. Replaces a
   * prior shell-out implementation that built the command line from the
   * caller-supplied URL.
   * @param {string} url - URL to download from
   * @returns {Promise<Object>} Session data parsed from JSON
   */
  async downloadSession(url) {
    let target = this.validateCloneUrl(url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    let response;
    try {
      // Follow redirects manually so each hop is re-validated against the
      // allowlist. Letting fetch follow them implicitly would let an
      // allowlisted host bounce the request to internal IPs or arbitrary
      // origins, defeating the host check.
      for (let hop = 0; hop <= MAX_CLONE_REDIRECTS; hop++) {
        response = await fetch(target.toString(), {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'Accept': 'application/json, text/plain;q=0.9, */*;q=0.5' },
        });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(`Redirect with no Location header (HTTP ${response.status})`);
        }
        target = this.validateCloneUrl(new URL(location, target).toString());
      }
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`Too many redirects (limit ${MAX_CLONE_REDIRECTS})`);
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`);
      }
      throw error instanceof Error ? error : new Error(`Download failed: ${error}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
    }

    // Reject early if the server claims a size over the cap. Number(null) is
    // 0 so a missing header passes through; a malformed header parses as NaN
    // and we treat that as "no claim".
    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader) {
      const claimed = Number(lengthHeader);
      if (Number.isFinite(claimed) && claimed > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Session file too large: ${claimed} bytes (max ${MAX_DOWNLOAD_BYTES})`);
      }
    }

    // Stream the body so a host that omits or lies about content-length can't
    // make us buffer an unbounded payload before the cap check fires.
    const buffer = await this._readBodyWithCap(response, controller);

    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch (error) {
      // Include the underlying parser message and a short preview so an HTML
      // error page from the host doesn't look like a "corrupted file" to the
      // user.
      const preview = buffer.toString('utf8', 0, 200);
      throw new Error(
        `Invalid session file - not valid JSON (${error.message}). ` +
        `Response started with: ${JSON.stringify(preview)}`
      );
    }
  }

  /**
   * Read a fetch Response body into a Buffer, aborting as soon as the
   * accumulated byte count exceeds MAX_DOWNLOAD_BYTES.
   * @param {Response} response
   * @param {AbortController} controller
   * @returns {Promise<Buffer>}
   * @private
   */
  async _readBodyWithCap(response, controller) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Session file too large: ${buffer.length} bytes (max ${MAX_DOWNLOAD_BYTES})`);
      }
      return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_DOWNLOAD_BYTES) {
        try { controller.abort(); } catch { /* already aborted */ }
        throw new Error(`Session file too large: exceeded ${MAX_DOWNLOAD_BYTES} bytes mid-stream`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Validate session data structure
   * @param {Object} sessionData - Session data to validate
   * @throws {Error} If validation fails
   */
  validateSessionData(sessionData) {
    if (!sessionData.version) {
      throw new Error('Invalid session file - missing version');
    }

    if (!sessionData.conversation || !sessionData.conversation.id) {
      throw new Error('Invalid session file - missing conversation data');
    }

    if (!sessionData.messages || !Array.isArray(sessionData.messages)) {
      throw new Error('Invalid session file - missing or invalid messages');
    }

    if (sessionData.messages.length === 0) {
      throw new Error('Invalid session file - no messages found');
    }
  }

  /**
   * Install session in Claude Code directory structure
   * @param {Object} sessionData - Session data to install
   * @param {Object} options - Installation options
   * @returns {Promise<Object>} Installation result
   */
  async installSession(sessionData, options = {}) {
    const homeDir = os.homedir();
    const claudeDir = path.join(homeDir, '.claude');

    // Determine project directory
    const projectName = sessionData.conversation.project || 'shared-session';
    const projectDirName = this.sanitizeProjectName(projectName);

    // Create project directory structure
    // Format: ~/.claude/projects/-path-to-project/
    const projectDir = path.join(claudeDir, 'projects', projectDirName);
    await fs.ensureDir(projectDir);

    // Generate conversation filename with original ID
    const conversationId = sessionData.conversation.id;
    const conversationFile = path.join(projectDir, `${conversationId}.jsonl`);

    // Convert messages back to JSONL format (one JSON object per line)
    const jsonlContent = sessionData.messages
      .map(msg => JSON.stringify(msg))
      .join('\n');

    // Write conversation file
    await fs.writeFile(conversationFile, jsonlContent, 'utf8');

    console.log(chalk.gray(`📝 Created conversation file: ${conversationFile}`));

    // Create or update settings.json
    const settingsFile = path.join(projectDir, 'settings.json');
    const settings = {
      projectName: sessionData.conversation.project,
      projectPath: options.projectPath || process.cwd(),
      sharedSession: true,
      originalExport: {
        exportedAt: sessionData.exported_at,
        exportTool: sessionData.metadata?.exportTool,
        exportVersion: sessionData.metadata?.exportVersion
      },
      importedAt: new Date().toISOString()
    };

    await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');

    console.log(chalk.gray(`⚙️  Created settings file: ${settingsFile}`));

    return {
      success: true,
      sessionPath: conversationFile,
      projectDir,
      projectPath: settings.projectPath,
      conversationId,
      messageCount: sessionData.messages.length
    };
  }

  /**
   * Sanitize project name for directory usage
   * @param {string} projectName - Original project name
   * @returns {string} Sanitized name
   */
  sanitizeProjectName(projectName) {
    // Replace spaces and special chars with hyphens
    return projectName
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .toLowerCase();
  }
}

module.exports = SessionSharing;
