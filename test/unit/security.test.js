import { describe, it, expect } from 'vitest';
const request = require('supertest');
const { ChatsMobile } = require('../../src/chats-mobile.js');
const {
  AUTH_COOKIE_NAME,
  authorizeWebSocketUpgrade,
  isRequestAuthorized,
  parseCookies,
  safeEqual,
} = require('../../src/security.js');

describe('request authentication helpers', () => {
  it('compares credentials without accepting type or length mismatches', () => {
    expect(safeEqual('secret', 'secret')).toBe(true);
    expect(safeEqual('secret', 'different')).toBe(false);
    expect(safeEqual('secret', null)).toBe(false);
  });

  it('parses encoded cookie values and ignores malformed encodings', () => {
    expect(parseCookies('a=one; b=hello%20world')).toEqual({ a: 'one', b: 'hello world' });
    expect(parseCookies('bad=%E0%A4%A')).toEqual({});
  });

  it('accepts either the session cookie or a Bearer token', () => {
    expect(isRequestAuthorized({ headers: { cookie: `${AUTH_COOKIE_NAME}=secret` } }, 'secret')).toBe(true);
    expect(isRequestAuthorized({ headers: { authorization: 'Bearer secret' } }, 'secret')).toBe(true);
    expect(isRequestAuthorized({ headers: {} }, 'secret')).toBe(false);
  });
});

describe('WebSocket upgrade authorization', () => {
  const origins = new Set(['http://localhost:9876']);

  it('requires both a valid credential and an exact allowed origin', () => {
    const allowed = authorizeWebSocketUpgrade({
      origin: 'http://localhost:9876',
      req: { headers: { cookie: `${AUTH_COOKIE_NAME}=secret` } },
    }, 'secret', origins);
    expect(allowed).toEqual({ ok: true });
  });

  it('rejects missing credentials before transcript delivery', () => {
    const denied = authorizeWebSocketUpgrade({
      origin: 'http://localhost:9876',
      req: { headers: {} },
    }, 'secret', origins);
    expect(denied.statusCode).toBe(401);
  });

  it('rejects hostile and missing origins', () => {
    for (const origin of ['https://evil.example', undefined]) {
      const denied = authorizeWebSocketUpgrade({
        origin,
        req: { headers: { cookie: `${AUTH_COOKIE_NAME}=secret` } },
      }, 'secret', origins);
      expect(denied.statusCode).toBe(403);
    }
  });
});

describe('ChatsMobile HTTP authentication middleware', () => {
  function buildApp() {
    const chats = new ChatsMobile({ authToken: 'test-secret', port: 0, claudeDir: '/tmp/empty-claude-home' });
    chats.setupMiddleware();
    chats.app.get('/protected', (_req, res) => res.json({ ok: true }));
    return chats.app;
  }

  it('rejects unauthenticated API requests', async () => {
    await request(buildApp()).get('/protected').expect(401);
  });

  it('bootstraps an HttpOnly strict cookie then removes the token from the URL', async () => {
    const response = await request(buildApp()).get('/?token=test-secret').expect(303);
    expect(response.headers.location).toBe('/');
    expect(response.headers['set-cookie'][0]).toContain(`${AUTH_COOKIE_NAME}=test-secret`);
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('SameSite=Strict');
  });

  it('allows the authenticated cookie and emits hardening headers', async () => {
    const response = await request(buildApp())
      .get('/protected')
      .set('Cookie', `${AUTH_COOKIE_NAME}=test-secret`)
      .expect(200);
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
