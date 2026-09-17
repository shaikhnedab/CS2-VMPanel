'use strict';

/**
 * Safe error responses: never leak SQL/stack/internal paths to clients.
 * Controllers should `sendSafeError(req, res, err, fallbackMessage)`.
 */

function safeMessage(err) {
  const m = err && (err.message || err);
  if (typeof m !== 'string' || m.length === 0 || m.length > 300) return null;
  // Never pass through anything that smells like SQL/DB internals.
  if (/select|insert|update|delete|where|column|table|unknown|ER_|errno|sqlstate|sql_|syntax|constraint|duplicate|deadlock/i.test(m)) return null;
  return m;
}

function sendSafeError(req, res, err, fallback = 'Something went wrong. Please try again.') {
  const logger = require('../modules/logger')('HTTP');
  try {
    logger.error(`[${(req && req.uuid) || '-'}] ${req && req.method} ${req && req.originalUrl} ->`, err && (err.stack || err));
  } catch (_) { /* logger must never throw */ }
  const msg = safeMessage(err) || fallback;
  return res.status(500).json({ success: false, data: { message: msg, requestId: (req && req.uuid) || undefined } });
}

module.exports = { sendSafeError };
