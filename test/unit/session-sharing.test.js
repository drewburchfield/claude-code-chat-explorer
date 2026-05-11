/**
 * SessionSharing.validateCloneUrl unit tests
 *
 * The clone path used to shell out to curl with the caller-supplied URL
 * interpolated into the command string. Now the URL goes through a pure
 * validator before it ever reaches the network. These tests pin down the
 * validator's contract so a future refactor can't quietly relax it.
 */
import { describe, it, expect } from 'vitest';
const SessionSharing = require('../../src/session-sharing.js');

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

  it('accepts a subdomain of an allowlisted host', () => {
    const parsed = ss.validateCloneUrl('https://cdn.x0.at/abc.json');
    expect(parsed.hostname).toBe('cdn.x0.at');
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
