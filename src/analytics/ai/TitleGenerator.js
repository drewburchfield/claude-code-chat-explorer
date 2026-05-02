const chalk = require('chalk');

/**
 * TitleGenerator - Generates 5-word session titles using a local Ollama model.
 *
 * Reads the first 3 user messages from each conversation and asks Ollama
 * (default: llama3.2:1b) to summarize them into a 5-word title.
 *
 * Falls back gracefully if Ollama is not running — existing summaries
 * (first 80 chars of first message) remain as-is.
 *
 * Usage:
 *   const gen = new TitleGenerator(db);
 *   await gen.generateAll(onTitleReady);  // onTitleReady(id, title) called per result
 */
class TitleGenerator {
  constructor(databaseManager, options = {}) {
    this.db = databaseManager;
    this.ollamaUrl = options.ollamaUrl || 'http://localhost:11434';
    this.model = options.model || 'llama3.2:1b';
    this.concurrency = options.concurrency || 3; // parallel requests
    this.timeoutMs = options.timeoutMs || 15000;  // 15s per title
    this.isAvailable = null; // null = unchecked
  }

  /**
   * Check whether Ollama is running and the model is available.
   * @returns {Promise<boolean>}
   */
  async checkAvailability() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${this.ollamaUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) { this.isAvailable = false; return false; }

      const data = await res.json();
      const models = (data.models || []).map(m => m.name);
      // Accept exact match or name-without-tag match (e.g. "llama3.2:1b" or "llama3.2")
      const base = this.model.split(':')[0];
      this.isAvailable = models.some(m => m === this.model || m.startsWith(base + ':') || m === base);

      if (!this.isAvailable) {
        console.log(chalk.yellow(`⚠️  TitleGenerator: model "${this.model}" not found in Ollama.`));
        console.log(chalk.gray(`   Available: ${models.join(', ') || 'none'}`));
        console.log(chalk.gray(`   Run: ollama pull ${this.model}`));
      }
      return this.isAvailable;
    } catch (_) {
      this.isAvailable = false;
      return false;
    }
  }

  /**
   * Generate a 5-word title for the given messages.
   * @param {string[]} messages - Up to 3 user message strings
   * @returns {Promise<string|null>} Generated title or null on failure
   */
  async generateTitle(messages) {
    if (!messages || messages.length === 0) return null;

    const context = messages
      .map((m, i) => `Message ${i + 1}: ${m.slice(0, 300)}`)
      .join('\n');

    const prompt =
      `You are a conversation title generator. Given the first messages of a coding assistant conversation, output ONLY a concise 5-word title. No punctuation at the end. No quotes. Just 5 words.\n\n${context}\n\n5-word title:`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: { temperature: 0.3, num_predict: 20 }
        }),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) return null;
      const data = await res.json();
      const raw = (data.response || '').trim();

      // Clean up: take only first line, strip quotes/punctuation, limit words
      const cleaned = raw
        .split('\n')[0]
        .replace(/^["']|["']$/g, '')
        .replace(/[.!?]+$/, '')
        .trim();

      // Enforce 5-word cap
      const words = cleaned.split(/\s+/).filter(Boolean);
      return words.slice(0, 5).join(' ') || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Run title generation for all conversations that don't have an AI title yet.
   * Calls onTitleReady(id, title) each time a title is generated.
   *
   * @param {Function} onTitleReady - Callback invoked with (conversationId, title)
   * @returns {Promise<{generated: number, skipped: number, failed: number}>}
   */
  async generateAll(onTitleReady) {
    const stats = { generated: 0, skipped: 0, failed: 0 };

    // Check Ollama availability first
    const available = await this.checkAvailability();
    if (!available) {
      console.log(chalk.gray('💡 TitleGenerator: Ollama not available — skipping AI titles.'));
      console.log(chalk.gray(`   To enable: install Ollama, then run: ollama pull ${this.model}`));
      return stats;
    }

    const pending = this.db.getConversationsNeedingTitles();
    if (pending.length === 0) {
      console.log(chalk.gray('✅ TitleGenerator: All conversations already have AI titles.'));
      return stats;
    }

    console.log(chalk.cyan(`🏷️  Generating AI titles for ${pending.length} conversation(s) using ${this.model}...`));

    // Process in batches respecting concurrency limit
    for (let i = 0; i < pending.length; i += this.concurrency) {
      const batch = pending.slice(i, i + this.concurrency);

      await Promise.all(batch.map(async (conv) => {
        const title = await this.generateTitle(conv.firstMessages);
        if (title) {
          this.db.updateSummary(conv.id, title);
          this.db.markAiTitled(conv.id);
          stats.generated++;
          if (onTitleReady) onTitleReady(conv.id, title);
        } else {
          stats.failed++;
        }
      }));
    }

    console.log(chalk.green(`✅ TitleGenerator: ${stats.generated} titles generated, ${stats.failed} failed.`));
    return stats;
  }
}

module.exports = TitleGenerator;
