'use strict';

// Minimal JSON/text HTTP client on Node's built-in https.
//
// Deliberately not needle: needle's params-object request form
// (needle.get(url, {...params}, opts, cb)) throws a SYNCHRONOUS
// ERR_OSSL_UNSUPPORTED from inside the library against
// api.steampowered.com on some hosts. Because it is thrown before the
// callback/promise chain exists, neither try/catch nor .catch() sees it —
// it escapes as an uncaught exception and takes the whole process down.
// Verified locally: that exact call form crashes 6/6, while
// needle('get', fullUrl, opts) succeeds 6/6. This helper takes the proven
// path (query string + built-in https) and adds a hard wall-clock timeout
// so no Steam call can hang a request.

const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BYTES = 4 * 1024 * 1024;

function buildQuery(params) {
  if (!params) return '';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    q.append(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

function parseBody(text, contentType) {
  if (typeof text !== 'string' || text === '') return text;
  if (contentType && /application\/json/i.test(contentType)) {
    try { return JSON.parse(text); } catch (e) { /* leave raw text */ }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch (e) { /* leave raw text */ }
  }
  return text;
}

/**
 * GET a URL and resolve { statusCode, headers, body }. Never rejects on
 * transport/HTTP failure — errors are reported via `ok: false` + `error`.
 * Only a bad argument rejects.
 */
function httpGet(rawUrl, { params, timeout = DEFAULT_TIMEOUT_MS, headers, redirects = 2 } = {}) {
  return new Promise((resolve, reject) => {
    if (!rawUrl || typeof rawUrl !== 'string') {
      return reject(new TypeError('httpGet requires a URL string'));
    }
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (e) {
      return reject(new TypeError(`Invalid URL: ${rawUrl}`));
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return reject(new TypeError(`Unsupported protocol: ${parsed.protocol}`));
    }

    const send = (target, hopsLeft) => {
      // Re-parse per hop: target is a string, and redirects may switch scheme.
      let u;
      try { u = new URL(target); } catch (e) { return resolve({ ok: false, statusCode: 0, headers: {}, body: null, error: 'Invalid URL' }); }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return resolve({ ok: false, statusCode: 0, headers: {}, body: null, error: `Unsupported protocol: ${u.protocol}` });
      }
      const lib = u.protocol === 'https:' ? https : http;
      let settled = false;
      const done = (result) => { if (!settled) { settled = true; resolve(result); } };
      const fail = (message) => done({ ok: false, statusCode: 0, headers: {}, body: null, error: message });

      const req = lib.request(
        u,
        { method: 'GET', headers: { 'User-Agent': 'CS2-VMPanel/2.0', ...(headers || {}) } },
        (res) => {
          const status = res.statusCode || 0;
          // Bounded redirect following (Steam occasionally redirects XML calls).
          if (status >= 300 && status < 400 && res.headers.location && hopsLeft > 0) {
            res.resume();
            let nextUrl;
            try { nextUrl = new URL(res.headers.location, u).toString(); } catch (e) { return fail('Bad redirect'); }
            return send(nextUrl, hopsLeft - 1);
          }
          let text = '';
          let bytes = 0;
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_BYTES) { req.destroy(); return fail('Response too large'); }
            text += chunk;
          });
          res.on('end', () => {
            done({
              ok: status >= 200 && status < 300,
              statusCode: status,
              headers: res.headers,
              body: parseBody(text, res.headers['content-type']),
              error: status >= 400 ? `HTTP ${status}` : null,
            });
          });
          res.on('error', (e) => fail(e.message));
        }
      );

      req.setTimeout(timeout, () => { req.destroy(); fail(`Timed out after ${timeout}ms`); });
      req.on('error', (e) => fail(e.code || e.message));
      req.end();
    };

    send(parsed.toString() + buildQuery(params), redirects);
  });
}

module.exports = { httpGet, DEFAULT_TIMEOUT_MS };
