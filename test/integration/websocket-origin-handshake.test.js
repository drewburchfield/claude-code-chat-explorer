/**
 * WebSocket handshake origin-rejection integration test.
 *
 * The unit tests in test/unit/WebSocketServer-origin.test.js pin verifyOrigin's
 * logic, but they call it through the prototype with a stub `this` — so every
 * one of them stays green even if the `verifyClient` option is deleted from
 * initialize() and the guard is never wired to the server at all.
 *
 * This test closes that gap by driving a real handshake over a real socket:
 * it proves the option is connected AND that ws actually honors the return
 * value (aborting with HTTP 401 for the single-arity verifyClient form).
 */
import { describe, it, expect, afterEach } from 'vitest';
const http = require('http');
const WebSocket = require('ws');
const WebSocketServer = require('../../src/analytics/notifications/WebSocketServer.js');

let httpServer;
let wsServer;

afterEach(async () => {
  if (wsServer) {
    await wsServer.close();
    wsServer = null;
  }
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
    httpServer = null;
  }
});

async function startServer() {
  httpServer = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  wsServer = new WebSocketServer(httpServer, { path: '/ws' });
  await wsServer.initialize();
  return httpServer.address().port;
}

/**
 * Attempt a handshake and resolve with what happened.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function handshake(port, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
    const done = (result) => {
      try { ws.close(); } catch { /* already closed */ }
      resolve(result);
    };
    ws.on('open', () => done({ ok: true }));
    ws.on('error', (err) => done({ ok: false, error: err.message }));
  });
}

describe('WebSocket handshake origin enforcement (wired end-to-end)', () => {
  it('rejects a cross-site Origin at the handshake with 401', async () => {
    const port = await startServer();
    const result = await handshake(port, 'https://evil.example');

    expect(result.ok).toBe(false);
    // ws surfaces the abort as "Unexpected server response: 401". Asserting the
    // code proves the rejection came from verifyClient, not a connection error.
    expect(result.error).toMatch(/401/);
  });

  it('accepts a same-origin handshake', async () => {
    const port = await startServer();
    const result = await handshake(port, `http://127.0.0.1:${port}`);

    expect(result.ok).toBe(true);
  });

  it('accepts a client that sends no Origin header (non-browser)', async () => {
    const port = await startServer();
    const result = await handshake(port, null);

    expect(result.ok).toBe(true);
  });
});
