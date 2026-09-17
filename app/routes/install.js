'use strict';

const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const logger = require('../modules/logger')('Install');
const { mintInstallToken, verifyInstallToken } = require('../utils/installToken');

function verifyInstallTokenMw(req, res, next) {
  const provided =
    (req.headers['x-csrf-token']) ||
    (req.body && (req.body._csrf || req.body.csrfToken));
  if (!verifyInstallToken(provided, 2 * 60 * 60 * 1000)) {
    if ((req.path || '').endsWith('/test-connection')) {
      return res.status(403).json({ success: false, data: { message: 'CSRF token mismatch. Reload the page and try again.' } });
    }
    return res.status(403).render('Install', {
      error: 'Session expired. Reload the page and try again.',
      values: safeValues(req.body),
      csrfToken: mintInstallToken(),
    });
  }
  return next();
}

const DB_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
const ADMIN_USER_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const STEAM_KEY_RE = /^[A-Za-z0-9]{16,64}$/;

let installing = false;
let setupDoneOverride = false;

function isComplete() {
  if (setupDoneOverride) return true;
  try {
    return config.isSetupComplete();
  } catch (e) {
    return false;
  }
}

function markComplete() {
  setupDoneOverride = true;
}

function fieldError(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return `${name} is required`;
  }
  return null;
}

function validateInstallBody(body) {
  const errors = [];
  const v = {};
  v.dbHost = String((body && body.db_host) || '').trim();
  v.dbPort = String((body && body.db_port) || '').trim();
  v.dbUser = String((body && body.db_user) || '').trim();
  v.dbPassword = body && body.db_password !== undefined ? String(body.db_password) : '';
  v.dbName = String((body && body.db_name) || '').trim();
  v.adminUsername = String((body && body.admin_username) || '').trim();
  v.adminPassword = body && body.admin_password !== undefined ? String(body.admin_password) : '';
  v.adminPasswordConfirm = body && body.admin_password_confirm !== undefined ? String(body.admin_password_confirm) : '';
  v.steamApiKey = String((body && body.steam_api_key) || '').trim();

  const hostErr = fieldError(v.dbHost, 'Database host');
  if (hostErr) errors.push(hostErr);
  else if (v.dbHost.length > 255 || /[\s;'"`\\]/.test(v.dbHost)) errors.push('Database host is invalid');

  const port = Number(v.dbPort);
  if (!v.dbPort) errors.push('Database port is required');
  else if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('Database port must be 1-65535');

  const userErr = fieldError(v.dbUser, 'Database user');
  if (userErr) errors.push(userErr);
  else if (v.dbUser.length > 64 || /[\s;'"`\\]/.test(v.dbUser)) errors.push('Database user is invalid');

  if (!v.dbName) errors.push('Database name is required');
  else if (!DB_NAME_RE.test(v.dbName)) errors.push('Database name must be 1-64 chars: letters, numbers, underscore');

  if (!v.adminUsername) errors.push('Admin username is required');
  else if (!ADMIN_USER_RE.test(v.adminUsername)) errors.push('Admin username must be 3-32 chars: letters, numbers, _ . -');

  if (!v.adminPassword) errors.push('Admin password is required');
  else if (v.adminPassword.length < 8) errors.push('Admin password must be at least 8 characters');
  if (v.adminPassword !== v.adminPasswordConfirm) errors.push('Passwords do not match');

  if (v.steamApiKey && !STEAM_KEY_RE.test(v.steamApiKey)) errors.push('Steam API key looks invalid');

  v.dbPortNum = port;
  return { errors, values: v };
}

async function testConnection(opts) {
  const mysql = require('mysql2/promise');
  let conn = null;
  try {
    conn = await mysql.createConnection({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      database: opts.database,
      connectTimeout: 5000,
    });
    await conn.query('SELECT 1');
    return { ok: true };
  } catch (e) {
    return { ok: false };
  } finally {
    if (conn) {
      try { await conn.end(); } catch (e) { /* ignore */ }
    }
  }
}

function registerInstallRoutes(app) {
  // Separate budgets: connection tests are harmless probes (generous budget
  // so normal retrying never trips it); the submit writes config + secrets
  // and stays tight. Both answer 429 in the shape each caller expects
  // instead of express-rate-limit's default plain-text body.
  const testLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({
      success: false,
      data: { message: 'Too many attempts. Wait a few minutes and try again.' },
    }),
  });
  const submitLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).render('Install', {
      error: 'Too many attempts. Wait a few minutes and try again.',
      values: safeValues(req.body),
      csrfToken: mintInstallToken(),
    }),
  });

  app.get('/install', (req, res) => {
    if (isComplete()) return res.status(404).render('404');
    return res.render('Install', {
      error: null,
      values: { db_host: '', db_port: '3306', db_user: '', db_name: '', admin_username: '', steam_api_key: '' },
      csrfToken: mintInstallToken(),
    });
  });

  app.post('/install/test-connection', testLimiter, verifyInstallTokenMw, async (req, res) => {
    if (isComplete()) return res.status(404).json({ success: false, data: { message: 'Not found' } });
    try {
      const host = String((req.body && req.body.db_host) || '').trim();
      const port = Number((req.body && req.body.db_port) || 3306);
      const user = String((req.body && req.body.db_user) || '').trim();
      const password = req.body && req.body.db_password !== undefined ? String(req.body.db_password) : '';
      const database = String((req.body && req.body.db_name) || '').trim();
      if (!host || !user || !database || !Number.isInteger(port) || port < 1 || port > 65535 || !DB_NAME_RE.test(database)) {
        return res.status(400).json({ success: false, data: { message: 'Invalid connection details' } });
      }
      const result = await testConnection({ host, port, user, password, database });
      if (!result.ok) {
        logger.info('Install connection test failed');
        return res.status(400).json({ success: false, data: { message: 'Could not connect to the database. Check host, port, user, and password.' } });
      }
      return res.json({ success: true, data: { message: 'Connection successful' } });
    } catch (e) {
      logger.info('Install connection test failed');
      return res.status(400).json({ success: false, data: { message: 'Could not connect to the database. Check host, port, user, and password.' } });
    }
  });

  app.post('/install', submitLimiter, verifyInstallTokenMw, async (req, res) => {
    if (isComplete()) return res.status(404).render('404');
    if (installing) return res.status(429).render('Install', {
      error: 'Setup is already in progress. Please wait and try again.',
      values: safeValues(req.body),
      csrfToken: mintInstallToken(),
    });
    const { errors, values } = validateInstallBody(req.body || {});
    if (errors.length > 0) {
      return res.status(400).render('Install', {
        error: errors[0],
        values: safeValues(req.body),
        csrfToken: mintInstallToken(),
      });
    }
    installing = true;
    let stage = 'writing configuration';
    try {
      const connTest = await testConnection({
        host: values.dbHost,
        port: values.dbPortNum,
        user: values.dbUser,
        password: values.dbPassword,
        database: values.dbName,
      });
      if (!connTest.ok) {
        logger.info('Install setup aborted: database unreachable');
        return res.status(400).render('Install', {
          error: 'Could not connect to the database. Check host, port, user, and password.',
          values: safeValues(req.body),
          csrfToken: mintInstallToken(),
        });
      }

      const hash = await bcrypt.hash(values.adminPassword, 12);
      const envWriter = require('../utils/envWriter');

      envWriter.writeEnv({
        DB_HOST: values.dbHost,
        DB_PORT: String(values.dbPortNum),
        DB_USER: values.dbUser,
        DB_PASSWORD: values.dbPassword,
        DB_NAME: values.dbName,
        JWT_SECRET: envWriter.generateSecret(32),
        APP_SESSION_SECRET: envWriter.generateSecret(32),
        STEAM_API_KEY: values.steamApiKey,
        SETUP_COMPLETE: 'false',
      });
      config.reload();

      const { resetPool } = require('../db/connection');
      await resetPool();

      stage = 'creating tables';
      const bootstrap = require('../db/bootstrap');
      await bootstrap();

      stage = 'applying database migrations';
      const { runMigrations } = require('../db/migrate');
      const db = require('../db/db_bridge');
      await runMigrations(db.query);

      stage = 'creating admin account';
      const userModel = require('../models/userModel');
      await userModel.createAdmin({ username: values.adminUsername, hash });

      stage = 'finalizing setup';
      envWriter.writeEnv({ SETUP_COMPLETE: 'true' });
      config.reload();
      markComplete();

      logger.info('First-boot setup completed');
      return res.redirect(302, '/login');
    } catch (e) {
      const summary = dbErrorSummary(e);
      logger.error(`Install setup failed while ${stage}${summary ? `: ${summary}` : ''}`);
      try {
        const { closePool } = require('../db/connection');
        await closePool();
      } catch (ce) { /* ignore */ }
      return res.status(500).render('Install', {
        error: `Setup failed while ${stage}${summary ? `: ${summary}` : ''}. Check the database details and try again.`,
        values: safeValues(req.body),
        csrfToken: mintInstallToken(),
      });
    } finally {
      installing = false;
    }
  });
}

// Short, credential-free failure summary for the wizard UI and logs.
// Only the error code/message are exposed — never the SQL text or values.
function dbErrorSummary(e) {
  if (!e) return '';
  const code = e.code || e.errno || '';
  const msg = e.sqlMessage || e.message || '';
  return `${code}${code && msg ? ': ' : ''}${msg}`.trim().slice(0, 200);
}

function safeValues(body) {
  const b = body || {};
  return {
    db_host: String(b.db_host || ''),
    db_port: String(b.db_port || '3306'),
    db_user: String(b.db_user || ''),
    db_name: String(b.db_name || ''),
    admin_username: String(b.admin_username || ''),
    steam_api_key: String(b.steam_api_key || ''),
  };
}

module.exports = registerInstallRoutes;
module.exports.validateInstallBody = validateInstallBody;
module.exports.isComplete = isComplete;
module.exports.markComplete = markComplete;
module.exports.resetInstallState = () => { installing = false; setupDoneOverride = false; };
