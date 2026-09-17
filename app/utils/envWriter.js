'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const logger = require('../modules/logger')('EnvWriter');

function dotenvPath() {
  return process.env.DOTENV_PATH || path.join(__dirname, '..', '..', '.env');
}

function generateSecret(bytes) {
  return crypto.randomBytes(bytes || 32).toString('hex');
}

function escapeValue(value) {
  const s = String(value === undefined || value === null ? '' : value);
  // Quote when the value contains whitespace, quotes, hash, or is empty-ish.
  if (s === '' || /[\s#"'`\\]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

// Read the current dotenv file (if any) into an ordered list of lines,
// preserving comments/blank lines. Returns { lines, index } where index
// maps KEY -> line number.
function readExisting(targetPath) {
  let content = null;
  try {
    content = fs.readFileSync(targetPath, 'utf8');
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
    return { lines: [], index: new Map() };
  }
  const lines = content.split('\n');
  const index = new Map();
  lines.forEach((line, i) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && !index.has(m[1])) index.set(m[1], i);
  });
  return { lines, index };
}

// Atomic write: tmp file with O_EXCL in the same directory, chmod 0600,
// fsync, then rename over the target. Never logs values.
function writeEnv(values) {
  const targetPath = dotenvPath();
  const dir = path.dirname(targetPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }

  const { lines, index } = readExisting(targetPath);
  const keys = Object.keys(values || {});
  for (const key of keys) {
    const line = `${key}=${escapeValue(values[key])}`;
    if (index.has(key)) {
      lines[index.get(key)] = line;
    } else {
      lines.push(line);
    }
  }
  const content = lines.join('\n').replace(/\n*$/, '') + '\n';

  const tmpName = `.env.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(dir, tmpName);
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
  } catch (e) {
    logger.error('Failed to create temp env file');
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
  fs.renameSync(tmpPath, targetPath);
  logger.info('Environment file written');
  return targetPath;
}

module.exports = { writeEnv, generateSecret, dotenvPath };
