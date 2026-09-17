// Central error handler — friendly, no stack/internal paths leaked to clients.
'use strict';

const logger = require('../modules/logger')('HTTP Error');

module.exports = function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  logger.error(`[${req.uuid || '-'}] ${req.method} ${req.originalUrl} ->`, err && (err.stack || err));
  if (res.headersSent) return next(err);

  const payload = { message: 'Something went wrong. Please try again.', requestId: req.uuid || undefined };
  if (status >= 400 && status < 500 && err.message && typeof err.message === 'string' && err.message.length < 200) {
    payload.message = err.message;
  }
  if (req.accepts('html')) {
    // render() itself can throw (e.g. missing view) — never let a stack
    // trace reach the client; fall back to a static page, then JSON.
    const sendStatic = () => {
      try {
        return res.status(status).send(
          '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Error</title>' +
          '<style>body{background:#0a0d14;color:#e8ecf3;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{border:1px solid #2a3140;border-radius:14px;padding:28px 32px;max-width:420px;text-align:center}</style></head><body>' +
          '<div class="card"><h1>Something went wrong</h1><p>Please try again.</p>' +
          (req.uuid ? `<p><small>Request ID: ${String(req.uuid).slice(0, 36)}</small></p>` : '') +
          '</div></body></html>'
        );
      } catch (e) {
        return res.status(status).json({ success: false, data: payload });
      }
    };
    if (status === 404) {
      try {
        return res.status(404).render('404');
      } catch (e) {
        return sendStatic();
      }
    }
    try {
      return res.status(status).render('404', { code: status });
    } catch (e) {
      return sendStatic();
    }
  }
  return res.status(status).json({ success: false, data: payload });
};