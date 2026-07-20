const crypto = require('crypto');

const AUTH_COOKIE_NAME = 'chat_explorer_session';

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // A malformed cookie is never a valid credential.
    }
  }
  return cookies;
}

function extractRequestToken(request) {
  const authorization = request?.headers?.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }
  return parseCookies(request?.headers?.cookie)[AUTH_COOKIE_NAME] || null;
}

function isRequestAuthorized(request, expectedToken) {
  if (!expectedToken) return true;
  return safeEqual(extractRequestToken(request), expectedToken);
}

function isOriginAllowed(origin, allowedOrigins) {
  if (typeof origin !== 'string' || !origin) return false;
  return allowedOrigins instanceof Set && allowedOrigins.has(origin);
}

function authorizeWebSocketUpgrade(info, expectedToken, allowedOrigins) {
  if (!isRequestAuthorized(info?.req, expectedToken)) {
    return { ok: false, statusCode: 401, message: 'Authentication required' };
  }
  if (!isOriginAllowed(info?.origin, allowedOrigins)) {
    return { ok: false, statusCode: 403, message: 'Origin not allowed' };
  }
  return { ok: true };
}

module.exports = {
  AUTH_COOKIE_NAME,
  authorizeWebSocketUpgrade,
  extractRequestToken,
  isOriginAllowed,
  isRequestAuthorized,
  parseCookies,
  safeEqual,
};
