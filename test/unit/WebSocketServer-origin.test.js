/**
 * WebSocketServer.verifyOrigin unit tests.
 *
 * verifyOrigin is the `verifyClient` guard that stops cross-site WebSocket
 * hijacking: a malicious page open in the user's browser must not be able to
 * open a socket to the locally-running server and read pushed conversation
 * data. Browsers do not apply the same-origin policy to WebSocket handshakes,
 * so this server-side check is the control.
 *
 * We invoke the method via the prototype with a stub `this` so the test does
 * not have to stand up a real HTTP/WebSocket server.
 */
import { describe, it, expect } from 'vitest';
const WebSocketServer = require('../../src/analytics/notifications/WebSocketServer.js');

// Build a fake `verifyClient` info object: { origin, req: { headers } }.
function info(origin, host, extra = {}) {
  return {
    origin,
    req: { headers: { origin, host, ...extra } }
  };
}

function verify(infoObj, options = {}) {
  return WebSocketServer.prototype.verifyOrigin.call({ options }, infoObj);
}

describe('WebSocketServer.verifyOrigin', () => {
  it('accepts a same-origin browser handshake (host matches Origin)', () => {
    expect(verify(info('http://localhost:9876', 'localhost:9876'))).toBe(true);
    expect(verify(info('http://127.0.0.1:9876', '127.0.0.1:9876'))).toBe(true);
  });

  it('accepts a Cloudflare-tunnel handshake without hard-coding the host', () => {
    expect(verify(info('https://abc-def.trycloudflare.com', 'abc-def.trycloudflare.com'))).toBe(true);
  });

  it('accepts a non-browser client that sends no Origin header', () => {
    // Native ws / curl / tests: no Origin => no ambient-authority CSRF risk.
    expect(verify(info(undefined, 'localhost:9876'))).toBe(true);
  });

  it('rejects a cross-site handshake (Origin host != request host)', () => {
    expect(verify(info('https://evil.example', 'localhost:9876'))).toBe(false);
  });

  it('rejects a cross-site handshake even when the port differs on the same hostname', () => {
    // A page on localhost:3000 is still a different origin than localhost:9876.
    expect(verify(info('http://localhost:3000', 'localhost:9876'))).toBe(false);
  });

  it('rejects an unparseable Origin rather than failing open', () => {
    expect(verify(info('not a url', 'localhost:9876'))).toBe(false);
  });

  it('honors an explicit allowedOrigins allowlist', () => {
    expect(
      verify(info('https://dashboard.internal', 'localhost:9876'), {
        allowedOrigins: ['https://dashboard.internal']
      })
    ).toBe(true);
  });
});
