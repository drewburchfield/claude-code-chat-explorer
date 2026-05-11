/**
 * SessionSharing.validateCloneUrl unit tests
 *
 * The clone path used to shell out to curl with the caller-supplied URL
 * interpolated into the command string. Now the URL goes through a pure
 * validator before it ever reaches the network. These tests pin down the
 * validator's contract so a future refactor can't quietly relax it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const SessionSharing = require('../../src/session-sharing.js');

// Build a Response-shaped object whose body streams the given chunks. We
// reach for this instead of real fetch so we can drive the safety paths
// (redirect, oversize, malformed JSON, timeouts) deterministically.
function fakeResponse({ status = 200, statusText = 'OK', headers = {}, chunks = [], ok }) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  let i = 0;
  return {
    status,
    statusText,
    ok: ok ?? (status >= 200 && status < 300),
    headers: { get: (k) => headerMap.get(String(k).toLowerCase()) ?? null },
    body: {
      getReader() {
        return {
          async read() {
            if (i >= chunks.length) return { value: undefined, done: true };
            return { value: chunks[i++], done: false };
          },
        };
      },
    },
    async arrayBuffer() {
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.byteLength; }
      return out.buffer;
    },
  };
}

function utf8(s) {
  return new TextEncoder().encode(s);
}

function makeSharing() {
  // The validator does not touch this.conversationAnalyzer, so a stub is fine.
  return new SessionSharing({});
}

describe('SessionSharing.validateCloneUrl', () => {
  const ss = makeSharing();

  it('accepts an https URL on an allowlisted host', () => {
    const parsed = ss.validateCloneUrl('https://x0.at/abc.json');
    expect(parsed.hostname).toBe('x0.at');
  });

  it('rejects subdomains of an allowlisted host (exact match only)', () => {
    // Subdomains are not implicitly trusted. If a specific subdomain ever
    // needs to be permitted, it should be added to the allowlist by name.
    expect(() => ss.validateCloneUrl('https://cdn.x0.at/abc.json'))
      .toThrow(/allowlist/i);
  });

  it('rejects javascript: URLs', () => {
    expect(() => ss.validateCloneUrl('javascript:alert(1)')).toThrow(/scheme/i);
  });

  it('rejects file: URLs', () => {
    expect(() => ss.validateCloneUrl('file:///etc/passwd')).toThrow(/scheme/i);
  });

  it('rejects data: URLs', () => {
    expect(() => ss.validateCloneUrl('data:text/plain,whatever')).toThrow(/scheme/i);
  });

  it('rejects empty string', () => {
    expect(() => ss.validateCloneUrl('')).toThrow(/required/i);
  });

  it('rejects non-string input', () => {
    expect(() => ss.validateCloneUrl(undefined)).toThrow();
    expect(() => ss.validateCloneUrl(null)).toThrow();
    expect(() => ss.validateCloneUrl(42)).toThrow();
  });

  it('rejects malformed URLs', () => {
    expect(() => ss.validateCloneUrl('not a url at all')).toThrow();
  });

  it('rejects hosts that are not on the allowlist', () => {
    expect(() => ss.validateCloneUrl('https://evil.example.com/abc.json'))
      .toThrow(/allowlist/i);
  });

  it('rejects hostnames that look like a substring of an allowed host', () => {
    // x0.at.evil.com is not a subdomain of x0.at; ensure no naive substring match.
    expect(() => ss.validateCloneUrl('https://x0.at.evil.com/abc.json'))
      .toThrow(/allowlist/i);
  });
});

describe('SessionSharing.downloadSession', () => {
  const ss = makeSharing();
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('parses a small JSON body on the happy path', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ chunks: [utf8('{"version":"1.0","messages":[]}')] })
    );
    const data = await ss.downloadSession('https://x0.at/abc.json');
    expect(data.version).toBe('1.0');
  });

  it('throws on HTTP error responses', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ status: 404, statusText: 'Not Found', chunks: [utf8('not found')] })
    );
    await expect(ss.downloadSession('https://x0.at/missing.json'))
      .rejects.toThrow(/HTTP 404/);
  });

  it('rejects up-front when content-length advertises an oversized body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({
        headers: { 'content-length': String(60 * 1024 * 1024) },
        chunks: [utf8('{}')],
      })
    );
    await expect(ss.downloadSession('https://x0.at/big.json'))
      .rejects.toThrow(/too large/i);
  });

  it('aborts mid-stream when a body without content-length exceeds the cap', async () => {
    // No content-length header; chunks sum to >50 MiB.
    const oneMiB = new Uint8Array(1024 * 1024);
    const chunks = Array.from({ length: 60 }, () => oneMiB);
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse({ chunks }));
    await expect(ss.downloadSession('https://x0.at/huge.json'))
      .rejects.toThrow(/exceeded.*bytes mid-stream/i);
  });

  it('ignores a malformed content-length value rather than crashing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({
        headers: { 'content-length': 'not-a-number' },
        chunks: [utf8('{"version":"1.0"}')],
      })
    );
    const data = await ss.downloadSession('https://x0.at/abc.json');
    expect(data.version).toBe('1.0');
  });

  it('surfaces the underlying parse error and a preview of the response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ chunks: [utf8('<html>maintenance</html>')] })
    );
    await expect(ss.downloadSession('https://x0.at/abc.json'))
      .rejects.toThrow(/not valid JSON.*Response started with/i);
  });

  it('translates AbortError into a timeout message', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    globalThis.fetch = vi.fn().mockRejectedValue(err);
    await expect(ss.downloadSession('https://x0.at/abc.json'))
      .rejects.toThrow(/timed out after/i);
  });

  it('re-validates the redirect target against the allowlist', async () => {
    // First response: 302 to a non-allowlisted host. The clone path must
    // reject this rather than silently following — otherwise the allowlist
    // is meaningless once an allowlisted host returns a redirect.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      fakeResponse({ status: 302, headers: { location: 'https://evil.example.com/x' } })
    );
    globalThis.fetch = fetchMock;
    await expect(ss.downloadSession('https://x0.at/abc.json'))
      .rejects.toThrow(/allowlist/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect to another allowlisted host', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(
        fakeResponse({ status: 302, headers: { location: 'https://transfer.sh/abc.json' } })
      )
      .mockResolvedValueOnce(
        fakeResponse({ chunks: [utf8('{"version":"1.0"}')] })
      );
    const data = await ss.downloadSession('https://x0.at/abc.json');
    expect(data.version).toBe('1.0');
  });

  it('bails out after the redirect hop limit', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ status: 302, headers: { location: 'https://x0.at/loop' } })
    );
    await expect(ss.downloadSession('https://x0.at/loop'))
      .rejects.toThrow(/too many redirects/i);
  });

  it('rejects a redirect that omits a Location header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      fakeResponse({ status: 302, headers: {} })
    );
    await expect(ss.downloadSession('https://x0.at/abc.json'))
      .rejects.toThrow(/no Location/i);
  });
});
