import { afterEach, describe, expect, it } from 'vitest';
const http = require('http');
const request = require('supertest');
const { createLoopbackProxy } = require('../../src/loopback-proxy.js');

describe('loopback proxy', () => {
  const servers = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  });

  it('forwards requests only to its configured upstream', async () => {
    const upstream = http.createServer((req, res) => {
      res.setHeader('Set-Cookie', 'chat_explorer_session=test; HttpOnly');
      res.end(`${req.method} ${req.url} ${req.headers.authorization}`);
    });
    servers.push(upstream);
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

    const proxy = createLoopbackProxy({
      upstreamHost: '127.0.0.1',
      upstreamPort: upstream.address().port,
    });
    servers.push(proxy);

    const response = await request(proxy)
      .get('/protected?value=1')
      .set('Authorization', 'Bearer secret')
      .expect(200);

    expect(response.text).toBe('GET /protected?value=1 Bearer secret');
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
  });

  it('returns 502 when the fixed upstream is unavailable', async () => {
    const proxy = createLoopbackProxy({ upstreamHost: '127.0.0.1', upstreamPort: 1 });
    servers.push(proxy);
    await request(proxy).get('/').expect(502, 'Chat Explorer is unavailable');
  });
});
