/**
 * ModelPricing unit tests.
 *
 * Pins the per-family rate rows, the model-id resolution, and the
 * ephemeral-5m vs 1h split. The previous codepath hardcoded Sonnet
 * rates for every conversation - this suite is the regression net so
 * a later rate-table refresh can't silently revert that fix. The
 * Opus row in particular is two-tier (4.5+ vs legacy 4/4.1) and the
 * delta is 3x, so explicit coverage of both rows guards against
 * accidentally collapsing them on a future edit.
 */
import { describe, it, expect } from 'vitest';
const { priceConversation, getRatesForModel, RATES, UNKNOWN_PRICING } = require('../../src/utils/ModelPricing.js');

describe('getRatesForModel', () => {
  it('returns modern Opus rates for Opus 4.5/4.6/4.7 ids', () => {
    for (const id of ['claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5-20250929']) {
      const r = getRatesForModel(id);
      expect(r.input).toBe(RATES.opus.input);
      expect(r.output).toBe(RATES.opus.output);
      expect(r.isUnknown).toBe(false);
    }
  });

  it('returns legacy Opus rates for Opus 4 / 4.1 / Opus 3 ids', () => {
    for (const id of ['claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-opus-3-20240229', 'Claude Opus 4']) {
      const r = getRatesForModel(id);
      expect(r.input).toBe(RATES.opusLegacy.input);
      expect(r.output).toBe(RATES.opusLegacy.output);
      expect(r.isUnknown).toBe(false);
    }
  });

  it('returns Sonnet rates for any sonnet-flavored id', () => {
    for (const id of ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929']) {
      const r = getRatesForModel(id);
      expect(r.input).toBe(RATES.sonnet.input);
      expect(r.output).toBe(RATES.sonnet.output);
      expect(r.isUnknown).toBe(false);
    }
  });

  it('returns Haiku 4.5 rates for haiku-4-x ids', () => {
    const r = getRatesForModel('claude-haiku-4-5-20251001');
    expect(r.input).toBe(RATES.haiku.input);
    expect(r.output).toBe(RATES.haiku.output);
    expect(r.isUnknown).toBe(false);
  });

  it('returns Haiku 3.5 rates for haiku-3-x ids', () => {
    const r = getRatesForModel('claude-haiku-3-5-20241022');
    expect(r.input).toBe(RATES.haikuLegacy.input);
    expect(r.output).toBe(RATES.haikuLegacy.output);
    expect(r.isUnknown).toBe(false);
  });

  it('falls back to unknown for empty, null, or unrecognised ids', () => {
    expect(getRatesForModel(null)).toEqual(UNKNOWN_PRICING);
    expect(getRatesForModel(undefined)).toEqual(UNKNOWN_PRICING);
    expect(getRatesForModel('')).toEqual(UNKNOWN_PRICING);
    expect(getRatesForModel('gpt-4o')).toEqual(UNKNOWN_PRICING);
    expect(getRatesForModel(42)).toEqual(UNKNOWN_PRICING);
  });
});

describe('priceConversation', () => {
  const usageMillion = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
  };

  it('prices a 1M-token-each Sonnet run against the Sonnet table', () => {
    const r = priceConversation({ tokenUsage: usageMillion, model: 'claude-sonnet-4-6' });
    expect(r.inputCost).toBeCloseTo(3, 5);
    expect(r.outputCost).toBeCloseTo(15, 5);
    expect(r.cacheWriteCost).toBeCloseTo(3.75, 5);
    expect(r.cacheReadCost).toBeCloseTo(0.3, 5);
    expect(r.totalCost).toBeCloseTo(22.05, 4);
    expect(r.isUnknownModel).toBe(false);
  });

  it('prices Opus 4.7 at the modern Opus rate ($5/$25, not $15/$75)', () => {
    const r = priceConversation({ tokenUsage: usageMillion, model: 'claude-opus-4-7' });
    expect(r.inputCost).toBeCloseTo(5, 5);
    expect(r.outputCost).toBeCloseTo(25, 5);
    expect(r.cacheWriteCost).toBeCloseTo(6.25, 5);
    expect(r.cacheReadCost).toBeCloseTo(0.5, 5);
  });

  it('prices Opus 4.1 at the legacy Opus rate ($15/$75)', () => {
    const r = priceConversation({ tokenUsage: usageMillion, model: 'claude-opus-4-1-20250805' });
    expect(r.inputCost).toBeCloseTo(15, 5);
    expect(r.outputCost).toBeCloseTo(75, 5);
    expect(r.cacheWriteCost).toBeCloseTo(18.75, 5);
    expect(r.cacheReadCost).toBeCloseTo(1.5, 5);
  });

  it('prices Haiku 4.5 below Sonnet, never confused with Sonnet', () => {
    const r = priceConversation({ tokenUsage: usageMillion, model: 'claude-haiku-4-5-20251001' });
    expect(r.inputCost).toBeCloseTo(1, 5);
    expect(r.outputCost).toBeCloseTo(5, 5);
  });

  it('splits cache writes between 5m and 1h tiers when both are present', () => {
    const r = priceConversation({
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 1_000_000,
        cacheCreation5mTokens: 600_000,
        cacheCreation1hTokens: 400_000,
        cacheReadTokens: 0,
      },
      model: 'claude-sonnet-4-6',
    });
    // 0.6M @ $3.75 + 0.4M @ $6.00 = $2.25 + $2.40 = $4.65
    expect(r.cacheWriteCost).toBeCloseTo(4.65, 4);
  });

  it('defaults cache writes to the 5m rate when only the legacy total is provided', () => {
    const r = priceConversation({
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 1_000_000, cacheReadTokens: 0 },
      model: 'claude-sonnet-4-6',
    });
    expect(r.cacheWriteCost).toBeCloseTo(3.75, 5);
  });

  it('flags isUnknownModel when the model id is missing', () => {
    const r = priceConversation({ tokenUsage: usageMillion, model: null });
    expect(r.isUnknownModel).toBe(true);
    // Sanity-check we still produce a finite total.
    expect(Number.isFinite(r.totalCost)).toBe(true);
  });

  it('handles a fully-empty usage payload without throwing', () => {
    const r = priceConversation({ tokenUsage: {}, model: 'claude-sonnet-4-6' });
    expect(r.totalCost).toBe(0);
    expect(r.isUnknownModel).toBe(false);
  });

  it('handles a fully-empty input', () => {
    const r = priceConversation({});
    expect(r.totalCost).toBe(0);
    expect(r.isUnknownModel).toBe(true);
  });

  it('does not double-count when legacy total and 1h split are both present', () => {
    // Legacy `cacheCreationTokens` represents the full cache write
    // pool; if the 1h sub-key is also present, the remainder is the
    // 5m portion. We should not bill the 1h portion at both rates.
    const r = priceConversation({
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 1_000_000,
        cacheCreation1hTokens: 400_000,
        cacheReadTokens: 0,
      },
      model: 'claude-sonnet-4-6',
    });
    // 600K @ $3.75 + 400K @ $6 = $2.25 + $2.40 = $4.65
    expect(r.cacheWriteCost).toBeCloseTo(4.65, 4);
  });
});
