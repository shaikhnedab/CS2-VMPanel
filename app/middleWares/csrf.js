// CSRF protection (synchronizer token pattern, session-bound).
// A token is minted lazily per session, exposed to every rendered page via
// res.locals.csrfToken, and verified on all state-changing requests.
// The frontend sends it either as `X-CSRF-Token` (fetch interceptor in
// vmp-ui.js) or as `_csrf` / `csrfToken` form field (legacy forms).

'use strict';

const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Mint token if missing and always expose to views.
const ensureCsrf = (req, res, next) => {
  try {
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.locals.csrfToken = req.session.csrfToken;
  } catch (e) {
    res.locals.csrfToken = '';
  }
  next();
};

// Reject state-changing requests that fail the token check.
const verifyCsrf = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const expected = req.session.csrfToken;
  if (!expected) {
    return res.status(403).json({ success: false, data: { message: 'CSRF token missing (session expired). Reload the page and try again.' } });
  }

  const provided =
    (req.headers['x-csrf-token']) ||
    (req.body && (req.body._csrf || req.body.csrfToken));
  if (!provided || String(provided) !== String(expected)) {
    return res.status(403).json({ success: false, data: { message: 'CSRF token mismatch. Reload the page and try again.' } });
  }
  next();
};

module.exports = { ensureCsrf, verifyCsrf };