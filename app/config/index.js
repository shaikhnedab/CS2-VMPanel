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

module.exports = config;