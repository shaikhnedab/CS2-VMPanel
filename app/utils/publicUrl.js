'use strict';

// Canonical public base URL shared by Steam OpenID, PayU callbacks, and any
// other absolute URL the panel hands out.
//
// A static HOSTNAME breaks whenever the panel is reached on a different host
// or port than configured (direct IP:port access, container hostnames,
// reverse proxies). Precedence: explicit PUBLIC_BASE_URL when valid,
// otherwise the address the browser actually used, otherwise localhost.
// req.protocol honors X-Forwarded-Proto when trust proxy is enabled.

// Accepts `https://vip.example.com`, `http://host:3535`, or bare
// `host[:port]` (defaults to http). Returns the normalized base or null when
// empty/unusable. Shared by the install-wizard validator.
function normalizePublicBaseUrl(value) {
  if (value === undefined || value === null) return null;
  let s = String(value).trim().replace(/\/+$/, '');
  if (!s || s.length > 253) return null;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s)) s = `http://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || /[\s<>\"']/.test(u.hostname)) return null;
  if (u.pathname && u.pathname !== '/') return null;
  if (u.search || u.hash || u.username || u.password) return null;
  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol}//${u.hostname}${port}`;
}

// Read at call time (not require time) so config.reload() picks up changes.
function explicitBaseUrl() {
  try {
    const raw = require('../config').publicBaseUrl;
    return normalizePublicBaseUrl(raw);
  } catch (e) { return null; }
}

function requestBaseUrl(req) {
  const proto = (req && req.protocol) || 'http';
  const host = (req && typeof req.get === 'function' && req.get('host')) || 'localhost';
  return `${proto}://${host}`;
}

function resolveBaseUrl(req) {
  return explicitBaseUrl() || requestBaseUrl(req);
}

module.exports = { normalizePublicBaseUrl, explicitBaseUrl, requestBaseUrl, resolveBaseUrl };
