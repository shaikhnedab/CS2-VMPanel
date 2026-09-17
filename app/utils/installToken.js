'use strict';

// Cookie-independent CSRF token for the first-boot installer.
//
// The wizard must work in browsers that block cookies (privacy extensions,
// hardened settings). Session-bound CSRF fails permanently there: every
// cookie-less request gets a fresh session with a freshly-minted token, so
// the submitted token can never match. These tokens are instead stateless:
// timestamp + HMAC under a per-process boot secret, verified with a
// timing-safe compare inside a bounded age window. They intentionally carry
// no secret material and are only honored by /install* routes (which add
// their own strict rate limit + single-flight mutex).

const crypto = require('crypto');

const WINDOW_MS = 2 * 60 * 60 * 1000; // tokens valid for 2 hours
const SKEW_MS = 60 * 1000; // tolerate clocks slightly ahead

let bootSecret = null;
function getBootSecret() {
  if (!bootSecret) bootSecret = crypto.randomBytes(32);
  return bootSecret;
}

function mintInstallToken(now = Date.now()) {
  const ts = String(now);
  const mac = crypto.createHmac('sha256', getBootSecret()).update(ts, 'utf8').digest('hex');
  return `${ts}.${mac}`;
}

function verifyInstallToken(tok, maxAgeMs = WINDOW_MS, now = Date.now()) {
  if (typeof tok !== 'string') return false;
  const parts = tok.split('.');
  if (parts.length !== 2) return false;
  const tsStr = parts[0];
  const mac = parts[1];
  if (!/^\d{10,16}$/.test(tsStr)) return false;
  if (!/^[0-9a-f]{64}$/.test(mac)) return false;
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return false;
  if (ts > now + SKEW_MS) return false; // issued in the future
  if (now - ts > maxAgeMs) return false; // expired
  const expected = crypto.createHmac('sha256', getBootSecret()).update(tsStr, 'utf8').digest('hex');
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { mintInstallToken, verifyInstallToken, getBootSecret, WINDOW_MS };
