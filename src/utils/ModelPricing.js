/**
 * ModelPricing - per-model cost estimation for Claude API token usage.
 *
 * Replaces a single-model hardcode (Sonnet 4.5 rates applied to every
 * conversation, regardless of which model actually answered) with a
 * lookup table keyed by the model id returned in the JSONL's
 * `message.model` field. Each row is a $/MTok rate for the five
 * accounting buckets we get back from the API: prompt input, model
 * output, 5-minute cache writes, 1-hour cache writes, and cache reads.
 *
 * **Source of truth:** docs.claude.com/en/docs/about-claude/pricing.
 * Rates can move; check PRICES_LAST_VERIFIED below and refresh as
 * needed. Off-list models resolve to UNKNOWN_PRICING and the caller
 * gets an `isUnknown: true` flag so the UI can render a warning badge
 * instead of silently extrapolating one family's rates onto another.
 */
const PRICES_LAST_VERIFIED = '2026-05-11';

// $/MTok. Two things to watch on refresh:
//   - Opus stepped down at 4.5: 4.5/4.6/4.7 bill at $5/$25; the older
//     Opus 4 / 4.1 / Opus 3 still bill at the legacy $15/$75 row.
//   - Long-context (>200K) requests on Sonnet/Opus 4.6+ bill at higher
//     rates that aren't exposed in the per-message usage block, so a
//     long-context run will under-estimate here. Acceptable for now;
//     the JSONL doesn't carry the signal we'd need to detect it.
const RATES = {
  opus: {
    input: 5,
    output: 25,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
  },
  opusLegacy: {
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
  haikuLegacy: {
    // Haiku 3.5. Haiku 3 is further below but we don't see those ids
    // in current transcripts; UNKNOWN_PRICING catches them with a
    // visible flag and slightly-over Sonnet rates, which we prefer
    // over silently extrapolating Haiku 4.5 rates onto Haiku 3.
    input: 0.8,
    output: 4,
    cacheWrite5m: 1,
    cacheWrite1h: 1.6,
    cacheRead: 0.08,
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
 * date-suffixed variants on the same family. Opus is split into a
 * modern row (4.5+) and a legacy row (4/4.1/Opus 3) because the rate
 * card dropped 3x at the 4.5 boundary.
 */
function getRatesForModel(modelId) {
  if (typeof modelId !== 'string' || !modelId) return UNKNOWN_PRICING;
  const id = modelId.toLowerCase();
  if (id.includes('opus')) {
    // Modern Opus tier covers 4.5, 4.6, 4.7 and any later 4.x release.
    // Default Opus matches to the legacy tier so a future 4.8 or 5.0
    // we forgot to encode under-estimates rather than over-estimates;
    // either way the user sees a finite, non-zero number.
    if (/opus-4-[5-9]/.test(id) || /opus-4-1\d/.test(id)) {
      return { ...RATES.opus, isUnknown: false };
    }
    return { ...RATES.opusLegacy, isUnknown: false };
  }
  if (id.includes('sonnet')) return { ...RATES.sonnet, isUnknown: false };
  if (id.includes('haiku')) {
    if (id.includes('haiku-3')) return { ...RATES.haikuLegacy, isUnknown: false };
    return { ...RATES.haiku, isUnknown: false };
  }
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
  const cacheWrite1h = tokenUsage.cacheCreation1hTokens ?? 0;
  // If we have the per-tier split, use the explicit 5m value.
  // Otherwise treat the legacy total as 5m and back out any known 1h
  // portion so we don't double-count it. The API charges the 5m rate
  // by default when callers don't request a 1h cache, and older
  // JSONLs predate the per-tier sub-keys.
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
