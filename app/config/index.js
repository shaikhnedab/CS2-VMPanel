'use strict';

// Load .env for every entry point (server, migrate, tooling). Safe no-op
// when the file or dotenv is absent.
try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

// Base config from config.json (kept for backwards compat), overridden by env vars.
// Secrets must come from environment in production — never commit config.json.

let rawConfig = {};
try {
  rawConfig = require('./config.json');
} catch (e) {
  rawConfig = require('./example_config.json');
}

const envBool = (v, fb) => {
  if (v === undefined || v === null || v === '') return fb;
  return v === true || v === 'true' || v === '1';
};

const config = {};
Object.assign(config, rawConfig);

config.db = {
  db_host: process.env.DB_HOST || (rawConfig.db && rawConfig.db.db_host),
  db_port: Number(process.env.DB_PORT || (rawConfig.db && rawConfig.db.db_port) || 3306),
  db_user: process.env.DB_USER || (rawConfig.db && rawConfig.db.db_user),
  db_password: process.env.DB_PASSWORD || (rawConfig.db && rawConfig.db.db_password),
  db_name: process.env.DB_NAME || (rawConfig.db && rawConfig.db.db_name),
};
config.hostname = process.env.HOSTNAME || rawConfig.hostname || 'localhost';
config.serverPort = process.env.SERVER_PORT || process.env.PORT || rawConfig.serverPort || '3535';
config.apacheProxy = envBool(process.env.APACHE_PROXY, !!rawConfig.apacheProxy);
config.scheduleConfig = {
  delete: String(process.env.SCHEDULE_DELETE_HOURS || (rawConfig.scheduleConfig && rawConfig.scheduleConfig.delete) || '12'),
  notif: String(process.env.SCHEDULE_NOTIF_HOURS || (rawConfig.scheduleConfig && rawConfig.scheduleConfig.notif) || '24'),
};
config.usersTable = process.env.USERS_TABLE || rawConfig.usersTable;
config.settingTable = process.env.SETTINGS_TABLE || rawConfig.settingTable;
config.serverTable = process.env.SERVERS_TABLE || rawConfig.serverTable;
config.salestable = process.env.SALES_TABLE || rawConfig.salestable;
config.audittable = process.env.AUDIT_TABLE || rawConfig.audittable;
config.bundletable = process.env.BUNDLES_TABLE || rawConfig.bundletable;
config.bundleRelTable = process.env.BUNDLE_REL_TABLE || rawConfig.bundleRelTable;
config.jwt = { key: process.env.JWT_SECRET || (rawConfig.jwt && rawConfig.jwt.key) };
config.app = { secret: process.env.APP_SESSION_SECRET || (rawConfig.app && rawConfig.app.secret) };
config.steam_api_key = process.env.STEAM_API_KEY !== undefined ? process.env.STEAM_API_KEY : rawConfig.steam_api_key;

const pg = rawConfig.payment_gateways || {};
config.payment_gateways = {
  paypal: { paypal_client_id: process.env.PAYPAL_CLIENT_ID || (pg.paypal && pg.paypal.paypal_client_id) || '' },
  payU: {
    enabled: envBool(process.env.PAYU_ENABLED, pg.payU && (pg.payU.enabled === true || pg.payU.enabled === 'true')),
    environment: process.env.PAYU_ENV || (pg.payU && pg.payU.environment) || 'test',
    merchantKey: process.env.PAYU_MERCHANT_KEY || (pg.payU && pg.payU.merchantKey) || '',
    merchantSalt: process.env.PAYU_MERCHANT_SALT || (pg.payU && pg.payU.merchantSalt) || '',
  },
  razorPay: {
    enabled: envBool(process.env.RAZORPAY_ENABLED, pg.razorPay && (pg.razorPay.enabled === true || pg.razorPay.enabled === 'true')),
    environment: process.env.RAZORPAY_ENV || (pg.razorPay && pg.razorPay.environment) || 'test',
    keyId: process.env.RAZORPAY_KEY_ID || (pg.razorPay && pg.razorPay.keyId) || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || (pg.razorPay && pg.razorPay.keySecret) || '',
  },
};
config.logging = { logLevel: process.env.LOG_LEVEL || (rawConfig.logging && rawConfig.logging.logLevel) || 'INFO' };

const path = require('path');
const fs = require('fs');

function dotenvPath() {
  return process.env.DOTENV_PATH || path.join(__dirname, '..', '..', '.env');
}

const EXAMPLE_PLACEHOLDERS = new Set([
  'change-me-strong',
  'change-me-min-32-chars-jwt-secret-please',
  'change-me-min-32-chars-session-secret',
  'add some random generated string here min 32length',
  'your_db_host',
  'your_db_username',
  "your_db_user's_password",
  'dbname',
]);

function isSetupComplete() {
  try {
    const p = dotenvPath();
    if (!fs.existsSync(p)) return false;
    if (String(process.env.SETUP_COMPLETE).toLowerCase() !== 'true') return false;
    const host = process.env.DB_HOST || '';
    const user = process.env.DB_USER || '';
    const name = process.env.DB_NAME || '';
    if (!host || !user || !name) return false;
    const jwt = process.env.JWT_SECRET || '';
    const appSecret = process.env.APP_SESSION_SECRET || '';
    if (!jwt || jwt.length < 32 || !appSecret || appSecret.length < 32) return false;
    if (EXAMPLE_PLACEHOLDERS.has(jwt) || EXAMPLE_PLACEHOLDERS.has(appSecret)) return false;
    if (EXAMPLE_PLACEHOLDERS.has(host) || EXAMPLE_PLACEHOLDERS.has(user) || EXAMPLE_PLACEHOLDERS.has(name)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function validateEnv() {
  const errors = [];
  if (!process.env.DB_HOST) errors.push('DB_HOST is required');
  if (!process.env.DB_USER) errors.push('DB_USER is required');
  if (!process.env.DB_NAME) errors.push('DB_NAME is required');
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) errors.push('JWT_SECRET must be at least 32 characters');
  if (!process.env.APP_SESSION_SECRET || process.env.APP_SESSION_SECRET.length < 32) errors.push('APP_SESSION_SECRET must be at least 32 characters');
  return errors;
}

function applyEnv(cfg) {
  let rc = rawConfig;
  cfg.db = {
    db_host: process.env.DB_HOST || (rc.db && rc.db.db_host),
    db_port: Number(process.env.DB_PORT || (rc.db && rc.db.db_port) || 3306),
    db_user: process.env.DB_USER || (rc.db && rc.db.db_user),
    db_password: process.env.DB_PASSWORD || (rc.db && rc.db.db_password),
    db_name: process.env.DB_NAME || (rc.db && rc.db.db_name),
  };
  cfg.hostname = process.env.HOSTNAME || rc.hostname || 'localhost';
  cfg.serverPort = process.env.SERVER_PORT || process.env.PORT || rc.serverPort || '3535';
  cfg.apacheProxy = envBool(process.env.APACHE_PROXY, !!rc.apacheProxy);
  cfg.scheduleConfig = {
    delete: String(process.env.SCHEDULE_DELETE_HOURS || (rc.scheduleConfig && rc.scheduleConfig.delete) || '12'),
    notif: String(process.env.SCHEDULE_NOTIF_HOURS || (rc.scheduleConfig && rc.scheduleConfig.notif) || '24'),
  };
  cfg.usersTable = process.env.USERS_TABLE || rc.usersTable;
  cfg.settingTable = process.env.SETTINGS_TABLE || rc.settingTable;
  cfg.serverTable = process.env.SERVER_TABLE || rc.serverTable;
  cfg.salestable = process.env.SALES_TABLE || rc.salestable;
  cfg.audittable = process.env.AUDIT_TABLE || rc.audittable;
  cfg.bundletable = process.env.BUNDLES_TABLE || rc.bundletable;
  cfg.bundleRelTable = process.env.BUNDLE_REL_TABLE || rc.bundleRelTable;
  cfg.jwt = { key: process.env.JWT_SECRET || (rc.jwt && rc.jwt.key) };
  cfg.app = { secret: process.env.APP_SESSION_SECRET || (rc.app && rc.app.secret) };
  cfg.steam_api_key = process.env.STEAM_API_KEY !== undefined ? process.env.STEAM_API_KEY : rc.steam_api_key;
  const pg = rc.payment_gateways || {};
  cfg.payment_gateways = {
    paypal: { paypal_client_id: process.env.PAYPAL_CLIENT_ID || (pg.paypal && pg.paypal.paypal_client_id) || '' },
    payU: {
      enabled: envBool(process.env.PAYU_ENABLED, pg.payU && (pg.payU.enabled === true || pg.payU.enabled === 'true')),
      environment: process.env.PAYU_ENV || (pg.payU && pg.payU.environment) || 'test',
      merchantKey: process.env.PAYU_MERCHANT_KEY || (pg.payU && pg.payU.merchantKey) || '',
      merchantSalt: process.env.PAYU_MERCHANT_SALT || (pg.payU && pg.payU.merchantSalt) || '',
    },
    razorPay: {
      enabled: envBool(process.env.RAZORPAY_ENABLED, pg.razorPay && (pg.razorPay.enabled === true || pg.razorPay.enabled === 'true')),
      environment: process.env.RAZORPAY_ENV || (pg.razorPay && pg.razorPay.environment) || 'test',
      keyId: process.env.RAZORPAY_KEY_ID || (pg.razorPay && pg.razorPay.keyId) || '',
      keySecret: process.env.RAZORPAY_KEY_SECRET || (pg.razorPay && pg.razorPay.keySecret) || '',
    },
  };
  cfg.logging = { logLevel: process.env.LOG_LEVEL || (rc.logging && rc.logging.logLevel) || 'INFO' };
  return cfg;
}

function reload() {
  try {
    require('dotenv').config({ path: dotenvPath(), override: true });
  } catch (e) { /* dotenv optional */ }
  try {
    rawConfig = require('./config.json');
  } catch (e) {
    try { rawConfig = require('./example_config.json'); } catch (e2) { /* keep previous */ }
  }
  applyEnv(config);
  return config;
}

config.isSetupComplete = isSetupComplete;
config.validateEnv = validateEnv;
config.reload = reload;

module.exports = config;