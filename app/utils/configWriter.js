'use strict';

// Writes the panel configuration file (app/config/config.json) during the
// first-boot wizard. Merges over the existing file (or the shipped example
// template when absent) so hand-edited keys — e.g. payment gateways — are
// never clobbered. Atomic write (tmp + rename, 0600); falls back to an
// in-place copy when rename is refused (bind-mounted file). Never logs values.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const logger = require('../modules/logger')('ConfigWriter');

function generateSecret(bytes) {
  return crypto.randomBytes(bytes || 32).toString('hex');
}

function targetPath() {
  try {
    return require('../config').configPath();
  } catch (e) {
    return process.env.CONFIG_PATH || path.join(__dirname, '..', 'config', 'config.json');
  }
}

function readBase(target) {
  const parseFile = (p) => {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw || !raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  };
  try {
    const existing = parseFile(target);
    if (existing) return existing;
  } catch (e) { /* fall through to template */ }
  try {
    const tpl = parseFile(path.join(__dirname, '..', 'config', 'example_config.json'));
    if (tpl) return tpl;
  } catch (e) { /* fall through */ }
  return {};
}

function writeConfig(values) {
  const target = targetPath();
  const dir = path.dirname(target);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }

  const base = readBase(target);
  const v = values || {};
  const has = (k) => v[k] !== undefined && v[k] !== null;

  base.db = Object.assign({}, base.db);
  if (has('db_host')) base.db.db_host = String(v.db_host);
  if (has('db_port') && v.db_port !== '') {
    const n = Number(v.db_port);
    base.db.db_port = Number.isFinite(n) ? n : base.db.db_port;
  }
  if (has('db_user')) base.db.db_user = String(v.db_user);
  if (has('db_password')) base.db.db_password = String(v.db_password);
  if (has('db_name')) base.db.db_name = String(v.db_name);

  if (has('jwt_secret')) base.jwt = Object.assign({}, base.jwt, { key: String(v.jwt_secret) });
  if (has('app_secret')) base.app = Object.assign({}, base.app, { secret: String(v.app_secret) });
  if (has('steam_api_key')) base.steam_api_key = String(v.steam_api_key);
  if (has('public_base_url')) base.publicBaseUrl = String(v.public_base_url);
  if (has('setup_complete')) base.setupComplete = v.setup_complete === true || v.setup_complete === 'true';

  const content = JSON.stringify(base, null, 2) + '\n';

  const tmpName = `.config.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(dir, tmpName);
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
  } catch (e) {
    logger.error('Failed to create temp config file');
    throw e;
  }
  try {
    fs.writeFileSync(fd, content, 'utf8');
    try { fs.fchmodSync(fd, 0o600); } catch (e) { /* best effort */ }
    try { fs.fsyncSync(fd); } catch (e) { /* best effort on tmpfs */ }
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
  try { fs.chmodSync(tmpPath, 0o600); } catch (e) { /* best effort */ }
  try {
    fs.renameSync(tmpPath, target);
  } catch (e) {
    // Bind-mounted target (./config.json:/app/app/config/config.json):
    // rename onto a mountpoint fails — copy through it instead.
    if (!e || !['EBUSY', 'EPERM', 'EXDEV', 'EACCES'].includes(e.code)) throw e;
    logger.info('Atomic rename unavailable, copying config file in place');
    try {
      fs.copyFileSync(tmpPath, target);
      try { fs.chmodSync(target, 0o600); } catch (ce) { /* best effort on mounts */ }
    } catch (copyErr) {
      try { fs.unlinkSync(tmpPath); } catch (u) { /* ignore */ }
      logger.error('Failed to write config file');
      throw copyErr;
    }
    try { fs.unlinkSync(tmpPath); } catch (u) { /* ignore */ }
  }
  logger.info('Configuration file written');
  return target;
}

module.exports = { writeConfig, generateSecret };
