const http = require('http');
const net = require('net');

function createLoopbackProxy(options = {}) {
  const upstreamHost = options.upstreamHost || process.env.CHAT_EXPLORER_UPSTREAM_HOST || 'chat-explorer';
  const upstreamPort = Number(options.upstreamPort || process.env.CHAT_EXPLORER_UPSTREAM_PORT || 9876);

  const server = http.createServer((request, response) => {
    const headers = { ...request.headers, host: `${upstreamHost}:${upstreamPort}` };
    const upstream = http.request({
      hostname: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.statusMessage, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });

    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' });
      response.end('Chat Explorer is unavailable');
    });
    request.pipe(upstream);
  });

  // Preserve the browser's Origin and Cookie headers verbatim so the app owns
  // WebSocket authentication and origin enforcement.
  server.on('upgrade', (request, clientSocket, head) => {
    const upstreamSocket = net.connect(upstreamPort, upstreamHost);
    upstreamSocket.once('connect', () => {
      const headerLines = [];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i];
        const value = name.toLowerCase() === 'host'
          ? `${upstreamHost}:${upstreamPort}`
          : request.rawHeaders[i + 1];
        headerLines.push(`${name}: ${value}`);
      }
      upstreamSocket.write(
        `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headerLines.join('\r\n')}\r\n\r\n`
      );
      if (head.length) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    });
    upstreamSocket.once('error', () => clientSocket.destroy());
  });

  return server;
}

if (require.main === module) {
  const host = process.env.CHAT_EXPLORER_PROXY_HOST || '0.0.0.0';
  const port = Number(process.env.CHAT_EXPLORER_PROXY_PORT || 9876);
  createLoopbackProxy().listen(port, host, () => {
    console.log(`Loopback proxy listening on ${host}:${port}`);
  });
}

module.exports = { createLoopbackProxy };
