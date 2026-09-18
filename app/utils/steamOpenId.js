'use strict';

// Steam OpenID realm/return URLs derived per request.
//
// A static HOSTNAME-based URL breaks whenever the panel is reached on a
// different host or port than configured (direct IP:port access, container
// hostnames, reverse proxies) — Steam then redirects the user to a dead
// address and login fails. req.protocol honors X-Forwarded-Proto when trust
// proxy is enabled; req host carries the port the browser actually used.

const SteamStrategy = require('passport-steam');

// Optional explicit public address (PUBLIC_BASE_URL in .env, asked by the
// install wizard). Accepts `https://vip.example.com`, `http://host:3535`, or
// bare `host[:port]` (defaults to http). Returns the normalized base or null
// when empty/unusable — callers fall back to request detection. Shared by the
// wizard validator so both sides agree on what is acceptable.
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

// Precedence: explicit PUBLIC_BASE_URL when valid, otherwise the address the
// browser actually used, otherwise localhost.
function steamBaseUrl(req) {
  const explicit = explicitBaseUrl();
  if (explicit) return explicit;
  const proto = (req && req.protocol) || 'http';
  const host = (req && typeof req.get === 'function' && req.get('host')) || 'localhost';
  return `${proto}://${host}`;
}

function steamReturnUrl(req) {
  return `${steamBaseUrl(req)}/auth/steam/return`;
}

function steamRealm(req) {
  return `${steamBaseUrl(req)}/`;
}

function verifySteamLogin(identifier, profile, done) {
  // asynchronous verification, for effect...
  process.nextTick(() => {
    profile.identifier = identifier;
    return done(null, profile);
  });
}

// A fresh instance per login request: passport-steam bakes returnURL/realm
// into its OpenID relying party at construction, so a shared singleton can
// never serve more than one public address. Construction is cheap; the
// in-flight request holds its own instance, so concurrent logins are safe.
function buildSteamStrategy(returnURL, realm, apiKey) {
  return new SteamStrategy({ returnURL, realm, apiKey }, verifySteamLogin);
}

module.exports = { steamBaseUrl, steamReturnUrl, steamRealm, buildSteamStrategy, normalizePublicBaseUrl };
