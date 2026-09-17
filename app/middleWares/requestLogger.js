'use strict';

const logger = require('../modules/logger')('HTTP');

// Request logging with timing + requestId, no sensitive data ever logged.
// Redacts common secret-bearing fields from the url query (never bodies).

const REDACT_QUERY_KEYS = ['token', 'key', 'secret', 'password', 'rcon', 'webhook', 'hash'];

function scrubUrl(url) {
  if (!url || url.indexOf('?') === -1) return url || '';
  const [base, qs] = url.split('?');
  const parts = qs.split('&').map((pair) => {
    const [k] = pair.split('=');
    if (REDACT_QUERY_KEYS.some((k2) => k.toLowerCase().indexOf(k2) !== -1)) return `${k}=REDACTED`;
    return pair;
  });
  return `${base}?${parts.join('&')}`;
}

module.exports = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durMs = Number(process.hrtime.bigint() - start) / 1e6;
    const user = (req.session && (req.session.username || (req.session.passport && req.session.passport.user && req.session.passport.user.displayName))) || 'guest';
    // Access logs are high-volume: keep them DEBUG so they don't flood VMPanel.log.
    logger.debug(`${req.method} ${scrubUrl(req.originalUrl)} -> ${res.statusCode} ${durMs.toFixed(1)}ms (${user}) [${req.uuid || '-'}]`);
  });
  next();
};

module.exports.scrubUrl = scrubUrl;