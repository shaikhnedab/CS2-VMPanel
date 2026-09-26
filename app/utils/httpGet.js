'use strict';

// Minimal HTTP client on Node's built-in https/http.
//
// Deliberately not needle: needle's params-object request form
// (needle.get(url, {...params}, opts, cb)) throws a SYNCHRONOUS
// ERR_OSSL_UNSUPPORTED from inside the library against
// api.steampowered.com on some hosts. Because it is thrown before the
// callback/promise chain exists, neither try/catch nor .catch() sees it —
// it escapes as an uncaught exception and takes the whole process down.
// Verified locally: that exact call form crashes 6/6, while
// needle('get', fullUrl, opts) succeeds 6/6.
//
// Every request here is bounded by a hard wall-clock timeout, so no outbound
// call (Steam, PayPal, Razorpay, PayU) can hang a request handler.

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
 * Issue a request and resolve { ok, statusCode, headers, body, error }.
 * Never rejects on transport/HTTP failure — failures are reported via
 * `ok: false` + `error`. Only a bad argument rejects.
 *
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {'GET'|'POST'} [opts.method='GET']
 * @param {object} [opts.params] query string values (GET)
 * @param {object} [opts.form]  application/x-www-form-urlencoded body (POST)
 * @param {*} [opts.json] JSON body (POST)
 * @param {object} [opts.headers]
 * @param {number} [opts.timeout=8000]
 * @param {number} [opts.redirects=2] 0 disables redirect following (POST-safe)
 */
function request(rawUrl, opts = {}) {
  const {
    method = 'GET', params, form, json, headers = {},
    timeout = DEFAULT_TIMEOUT_MS, redirects = 2,
  } = opts;

  return new Promise((resolve, reject) => {
    if (!rawUrl || typeof rawUrl !== 'string') {
      return reject(new TypeError('request requires a URL string'));
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

    // Build the body once; it is replayed verbatim on each hop.
    let payload = null;
    const outHeaders = { 'User-Agent': 'CS2-VMPanel/2.0', ...headers };
    if (form !== undefined && form !== null) {
      payload = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        if (v === undefined || v === null) continue;
        payload.append(k, String(v));
      }
      payload = payload.toString();
      outHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (json !== undefined) {
      payload = JSON.stringify(json);
      outHeaders['Content-Type'] = 'application/json';
    }
    if (payload !== null) {
      outHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const upper = String(method).toUpperCase();
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
        { method: upper, headers: outHeaders },
        (res) => {
          const status = res.statusCode || 0;
          // Bounded redirect following (Steam occasionally redirects XML calls).
          // Never replay a POST body across a redirect: it may have been
          // consumed, and gateway APIs do not redirect.
          if (status >= 300 && status < 400 && res.headers.location && hopsLeft > 0 && upper === 'GET') {
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
      if (payload !== null) req.write(payload);
      req.end();
    };

    send(upper === 'GET' ? parsed.toString() + buildQuery(params) : parsed.toString(), redirects);
  });
}

/** GET helper. */
function httpGet(rawUrl, opts = {}) {
  return request(rawUrl, { ...opts, method: 'GET' });
}

/** POST helper. */
function httpPost(rawUrl, opts = {}) {
  return request(rawUrl, { ...opts, method: 'POST' });
}

/** POST application/x-www-form-urlencoded. */
function httpPostForm(rawUrl, form, opts = {}) {
  return request(rawUrl, { ...opts, method: 'POST', form });
}

/** POST application/json. */
function httpPostJson(rawUrl, json, opts = {}) {
  return request(rawUrl, { ...opts, method: 'POST', json });
}

module.exports = {
  request, httpGet, httpPost, httpPostForm, httpPostJson, DEFAULT_TIMEOUT_MS,
};
