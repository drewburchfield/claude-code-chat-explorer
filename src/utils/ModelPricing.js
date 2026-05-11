/**
 * ModelPricing - per-model cost estimation for Claude API token usage.
 *
 * Replaces a single-model hardcode (Sonnet 4.5 rates applied to every
 * conversation, regardless of which model actually answered) with a
 * lookup table keyed by the model id prefix returned in the JSONL's
 * `message.model` field. Each row is a $/MTok rate for the five
 * accounting buckets we get back from the API: prompt input, model
 * output, 5-minute cache writes, 1-hour cache writes, and cache reads.
 *
 * **Source of truth:** anthropic.com/pricing. Rates can move; check
 * PRICES_LAST_VERIFIED below and refresh as needed. Off-list models
 * resolve to UNKNOWN_PRICING and the caller gets an `isUnknown: true`
 * flag so the UI can render a warning badge instead of silently
 * extrapolating Sonnet rates onto an Opus conversation (the bug this
 * module exists to fix).
 */
const PRICES_LAST_VERIFIED = '2026-05-11';

// $/MTok. Rates are public-tier ≤200K-context. Long-context requests
// on Sonnet bill at higher rates that aren't exposed in the per-message
// usage block, so a long-context run will under-estimate here.
const RATES = {
  opus: {
    input: 15,
    output: 75,
    cacheWrite5m: 18.75,
    cacheWrite1h: 30,
    cacheRead: 1.5,
  },
  sonnet: {
    input: 3,
    output: 15,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    cacheRead: 0.3,
  },
  haiku: {
    input: 1,
    output: 5,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    cacheRead: 0.1,
  },
};

const UNKNOWN_PRICING = {
  // Pick Sonnet rates as a neutral fallback so the displayed number
  // isn't wildly off when we don't recognise the model. The
  // `isUnknown` flag on the result lets the UI flag it for the user.
  ...RATES.sonnet,
  isUnknown: true,
};

/**
 * Resolve a model id (e.g. "claude-opus-4-7", "claude-sonnet-4-5-20250929")
 * to its rate row. Substring matching is intentional: the API stamps
 * date-suffixed variants on the same family.
 */
function getRatesForModel(modelId) {
  if (typeof modelId !== 'string' || !modelId) return UNKNOWN_PRICING;
  const id = modelId.toLowerCase();
  if (id.includes('opus')) return { ...RATES.opus, isUnknown: false };
  if (id.includes('sonnet')) return { ...RATES.sonnet, isUnknown: false };
  if (id.includes('haiku')) return { ...RATES.haiku, isUnknown: false };
  return UNKNOWN_PRICING;
}

/**
 * Price a conversation given its aggregate token usage. `usage` is
 * expected in the ConversationAnalyzer shape:
 *   {
 *     inputTokens, outputTokens,
 *     cacheCreationTokens,            // total of both ephemeral tiers
 *     cacheCreation5mTokens,          // optional, split when available
 *     cacheCreation1hTokens,          // optional, split when available
 *     cacheReadTokens,
 *   }
 *
 * Returns:
 *   {
 *     totalCost,            // USD
 *     inputCost,            // USD
 *     outputCost,           // USD
 *     cacheWriteCost,       // USD (5m + 1h combined)
 *     cacheReadCost,        // USD
 *     model,                // echoed back
 *     isUnknownModel,       // true if model id didn't match a known family
 *   }
 */
function priceConversation({ tokenUsage = {}, model } = {}) {
  const rates = getRatesForModel(model);
  const input = tokenUsage.inputTokens || 0;
  const output = tokenUsage.outputTokens || 0;
  const cacheRead = tokenUsage.cacheReadTokens || 0;
  // If we have the per-tier split, price it precisely. Otherwise fall
  // back to lumping all cache writes at the 5m rate - that's what the
  // API charges by default when callers don't request a 1h cache, and
  // older JSONLs predate the split sub-keys.
  const cacheWrite5m = tokenUsage.cacheCreation5mTokens
    ?? tokenUsage.cacheCreationTokens
    ?? 0;
  const cacheWrite1h = tokenUsage.cacheCreation1hTokens ?? 0;
  // Avoid double-counting when both are present.
  const cacheWrite5mAccounted = (tokenUsage.cacheCreation5mTokens != null)
    ? tokenUsage.cacheCreation5mTokens
    : Math.max(0, (tokenUsage.cacheCreationTokens || 0) - cacheWrite1h);

  const inputCost = (input / 1_000_000) * rates.input;
  const outputCost = (output / 1_000_000) * rates.output;
  const cache5mCost = (cacheWrite5mAccounted / 1_000_000) * rates.cacheWrite5m;
  const cache1hCost = (cacheWrite1h / 1_000_000) * rates.cacheWrite1h;
  const cacheReadCost = (cacheRead / 1_000_000) * rates.cacheRead;
  const cacheWriteCost = cache5mCost + cache1hCost;

  return {
    totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    model: model || null,
    isUnknownModel: rates.isUnknown === true,
  };
}

module.exports = {
  PRICES_LAST_VERIFIED,
  RATES,
  UNKNOWN_PRICING,
  getRatesForModel,
  priceConversation,
};
