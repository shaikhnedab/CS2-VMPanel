'use strict';
// First-boot installer tests (no real DB, never touches the real .env).
// Run: node tests/install.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0;
let fail = 0;
const results = [];
function record(name, err) {
  if (err) { fail++; results.push(`  FAIL - ${name}: ${err.message}`); }
  else { pass++; results.push(`  ok - ${name}`); }
}
function ok(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => record(name), (e) => record(name, e));
    }
    record(name);
    return Promise.resolve();
  } catch (e) {
    record(name, e);
    return Promise.resolve();
  }
}

// Isolate dotenv before any app module loads.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-install-'));
process.env.DOTENV_PATH = path.join(tmpDir, 'test.env');

async function main() {
  const config = require('../app/config');
  const envWriter = require('../app/utils/envWriter');
  const install = require('../app/routes/install');
  const { validateInstallBody } = install;
  const { runMigrations } = require('../app/db/migrate');

  const good = () => ({
    db_host: 'db.example.com',
    db_port: '3306',
    db_user: 'vmpanel',
    db_password: 's3cret-db-pass',
    db_name: 'vmpanel',
    admin_username: 'owner.admin-1',
    admin_password: 'twelve-chars-minimum!',
    admin_password_confirm: 'twelve-chars-minimum!',
    steam_api_key: '',
  });

  // ---- 1. pure validation ----
  await ok('validation accepts a good body', () => {
    const { errors } = validateInstallBody(good());
    assert.deepStrictEqual(errors, []);
  });
  await ok('validation rejects dbname injection', () => {
    const b = good(); b.db_name = 'x; DROP TABLE tbl_users;--';
    const { errors } = validateInstallBody(b);
    assert.ok(errors.length > 0);
  });
  await ok('validation rejects backticked dbname', () => {
    const b = good(); b.db_name = '`tbl_users`';
    const { errors } = validateInstallBody(b);
    assert.ok(errors.length > 0);
  });
  await ok('validation rejects short admin username', () => {
    const b = good(); b.admin_username = 'ab';
    const { errors } = validateInstallBody(b);
    assert.ok(errors.length > 0);
  });
  await ok('validation rejects admin username with spaces', () => {
    const b = good(); b.admin_username = 'evil admin';
    const { errors } = validateInstallBody(b);
    assert.ok(errors.length > 0);
  });
  await ok('validation rejects short admin password', () => {
    const b = good(); b.admin_password = 'short1!'; b.admin_password_confirm = 'short1!';
    const { errors } = validateInstallBody(b);
    assert.ok(errors.some((e) => /8/.test(e)));
  });
  await ok('validation accepts 8-char admin password', () => {
    const b = good(); b.admin_password = 'eight888'; b.admin_password_confirm = 'eight888';
    const { errors } = validateInstallBody(b);
    assert.deepStrictEqual(errors, []);
  });
  await ok('validation rejects password mismatch', () => {
    const b = good(); b.admin_password_confirm = 'different-password-123';
    const { errors } = validateInstallBody(b);
    assert.ok(errors.some((e) => /match/i.test(e)));
  });
  await ok('validation rejects bad port', () => {
    const b = good(); b.db_port = '99999';
    const { errors } = validateInstallBody(b);
    assert.ok(errors.length > 0);
  });
  await ok('validation rejects missing host', () => {
    const b = good(); b.db_host = '';
    const { errors } = validateInstallBody(b);
    assert.ok(errors.length > 0);
  });
  await ok('validation rejects invalid steam key', () => {
    const b = good(); b.steam_api_key = '!!!not-a-key!!!';
    const { errors } = validateInstallBody(b);
    assert.ok(errors.length > 0);
  });

  // ---- 2. envWriter round-trip in tmp dir (0600) ----
  await ok('envWriter round-trips values with 0600 perms', () => {
    const target = envWriter.writeEnv({ INSTALL_TEST_A: 'hello', INSTALL_TEST_B: 'a b#c' });
    assert.strictEqual(target, process.env.DOTENV_PATH);
    const content = fs.readFileSync(target, 'utf8');
    assert.ok(content.includes('INSTALL_TEST_A=hello'));
    assert.ok(content.includes('INSTALL_TEST_B="a b#c"'));
    const mode = fs.statSync(target).mode & 0o777;
    assert.strictEqual(mode, 0o600);
    // merge: second write preserves earlier keys
    envWriter.writeEnv({ INSTALL_TEST_C: 'third' });
    const content2 = fs.readFileSync(target, 'utf8');
    assert.ok(content2.includes('INSTALL_TEST_A=hello'));
    assert.ok(content2.includes('INSTALL_TEST_C=third'));
  });
  await ok('envWriter generates unique 64-hex secrets', () => {
    const a = envWriter.generateSecret();
    const b = envWriter.generateSecret();
    assert.ok(/^[a-f0-9]{64}$/.test(a));
    assert.ok(/^[a-f0-9]{64}$/.test(b));
    assert.notStrictEqual(a, b);
  });

  // ---- 3. isSetupComplete matrix (env save/restore) ----
  const savedEnv = { ...process.env };
  const matrixPath = path.join(tmpDir, 'matrix.env');
  const setEnv = (vars) => {
    for (const k of ['SETUP_COMPLETE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET', 'APP_SESSION_SECRET']) delete process.env[k];
    Object.assign(process.env, vars);
    process.env.DOTENV_PATH = matrixPath;
  };
  const restore = () => {
    for (const k of Object.keys(process.env)) { if (!(k in savedEnv)) delete process.env[k]; }
    Object.assign(process.env, savedEnv);
    process.env.DOTENV_PATH = path.join(tmpDir, 'test.env');
  };
  try {
    await ok('isSetupComplete false when file missing', () => {
      try { fs.unlinkSync(matrixPath); } catch (e) { /* absent */ }
      setEnv({ SETUP_COMPLETE: 'true', DB_HOST: 'h', DB_USER: 'u', DB_NAME: 'd', JWT_SECRET: 'x'.repeat(32), APP_SESSION_SECRET: 'y'.repeat(32) });
      assert.strictEqual(config.isSetupComplete(), false);
    });
    await ok('isSetupComplete false when flag not true', () => {
      fs.writeFileSync(matrixPath, 'x=1\n');
      setEnv({ SETUP_COMPLETE: 'false', DB_HOST: 'h', DB_USER: 'u', DB_NAME: 'd', JWT_SECRET: 'x'.repeat(32), APP_SESSION_SECRET: 'y'.repeat(32) });
      assert.strictEqual(config.isSetupComplete(), false);
    });
    await ok('isSetupComplete false when DB_HOST missing', () => {
      fs.writeFileSync(matrixPath, 'x=1\n');
      setEnv({ SETUP_COMPLETE: 'true', DB_USER: 'u', DB_NAME: 'd', JWT_SECRET: 'x'.repeat(32), APP_SESSION_SECRET: 'y'.repeat(32) });
      assert.strictEqual(config.isSetupComplete(), false);
    });
    await ok('isSetupComplete false when secrets short', () => {
      fs.writeFileSync(matrixPath, 'x=1\n');
      setEnv({ SETUP_COMPLETE: 'true', DB_HOST: 'h', DB_USER: 'u', DB_NAME: 'd', JWT_SECRET: 'short', APP_SESSION_SECRET: 'y'.repeat(32) });
      assert.strictEqual(config.isSetupComplete(), false);
    });
    await ok('isSetupComplete false on example placeholder secret', () => {
      fs.writeFileSync(matrixPath, 'x=1\n');
      setEnv({ SETUP_COMPLETE: 'true', DB_HOST: 'h', DB_USER: 'u', DB_NAME: 'd', JWT_SECRET: 'change-me-min-32-chars-jwt-secret-please', APP_SESSION_SECRET: 'y'.repeat(32) });
      assert.strictEqual(config.isSetupComplete(), false);
    });
    await ok('isSetupComplete true when complete', () => {
      fs.writeFileSync(matrixPath, 'x=1\n');
      setEnv({ SETUP_COMPLETE: 'true', DB_HOST: 'h', DB_USER: 'u', DB_NAME: 'd', JWT_SECRET: 'x'.repeat(32), APP_SESSION_SECRET: 'y'.repeat(32) });
      assert.strictEqual(config.isSetupComplete(), true);
    });
  } finally {
    restore();
  }

  // ---- 4. runMigrations export shape (no DB: stub queryFn) ----
  await ok('runMigrations applies files via injected queryFn', async () => {
    const seen = [];
    const fakeQuery = async (sql) => {
      seen.push(String(sql));
      if (/SELECT filename/i.test(String(sql))) return [];
      return { affectedRows: 1 };
    };
    const ran = await runMigrations(fakeQuery);
    assert.ok(Number.isInteger(ran) && ran >= 1);
    assert.ok(seen.some((s) => /schema_migrations/.test(s)));
  });

  // ---- 5. HTTP wizard flow (stubbed mysql2, no real DB) ----
  const httpEnv = path.join(tmpDir, 'http.env');
  try { fs.unlinkSync(httpEnv); } catch (e) { /* absent */ }
  process.env.DOTENV_PATH = httpEnv;
  for (const k of ['SETUP_COMPLETE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET', 'APP_SESSION_SECRET', 'STEAM_API_KEY']) delete process.env[k];
  install.resetInstallState();

  // Stub outbound MySQL connection attempts (ephemeral test-connection).
  const mysqlPromise = require('mysql2/promise');
  const origCreateConnection = mysqlPromise.createConnection;
  mysqlPromise.createConnection = async () => ({
    query: async () => [[{ '1': 1 }], []],
    end: async () => {},
  });
  // Stub pooled queries used by bootstrap/migrations/createAdmin.
  const dbBridge = require('../app/db/db_bridge');
  const origQuery = dbBridge.query;
  dbBridge.query = async (sql, singleRecord) => {
    const s = String(sql || '').trim().toUpperCase();
    if (s.startsWith('SELECT') || s.startsWith('SHOW')) {
      const rows = [];
      if (singleRecord) return rows[0];
      return rows;
    }
    return { affectedRows: 1, insertId: 1 };
  };

  const { createApp } = require('../server');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;

  let jar = [];
  const request = (method, reqPath, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const opts = {
      host: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: { ...headers },
    };
    if (jar.length) opts.headers.Cookie = jar.join('; ');
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          for (const c of setCookie) jar.push(c.split(';')[0]);
        }
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
  const extractCsrf = (html) => {
    const m = String(html).match(/name="_csrf" value="([^"]+)"/) || String(html).match(/name="csrf-token" content="([^"]+)"/);
    return m ? m[1] : null;
  };

  try {
    let csrfToken = null;
    await ok('wizard redirects /login to /install when incomplete', async () => {
      const r = await request('GET', '/login');
      assert.strictEqual(r.status, 302);
      assert.strictEqual(r.headers.location, '/install');
    });
    await ok('healthz stays open during setup', async () => {
      const r = await request('GET', '/healthz');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(JSON.parse(r.body), { ok: true });
    });
    await ok('wizard GET /install renders form', async () => {
      const r = await request('GET', '/install');
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.includes('<form'));
      csrfToken = extractCsrf(r.body);
      assert.ok(csrfToken && csrfToken.length >= 32);
    });
    await ok('wizard test-connection succeeds with stubbed mysql', async () => {
      const payload = JSON.stringify({ db_host: 'h', db_port: 3306, db_user: 'u', db_password: 'p', db_name: 'vmpanel', _csrf: csrfToken });
      const r = await request('POST', '/install/test-connection', {
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, 'Content-Length': Buffer.byteLength(payload) },
        body: payload,
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(JSON.parse(r.body).success, true);
    });
    await ok('wizard rejects weak admin password without secrets', async () => {
      const form = new URLSearchParams({
        db_host: 'h', db_port: '3306', db_user: 'u', db_password: 'p', db_name: 'vmpanel',
        admin_username: 'owner', admin_password: 'short', admin_password_confirm: 'short',
        steam_api_key: '', _csrf: csrfToken,
      }).toString();
      const r = await request('POST', '/install', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
        body: form,
      });
      assert.strictEqual(r.status, 400);
      assert.ok(!/s3cret|supersecret/i.test(r.body));
    });
    await ok('wizard POST /install completes and redirects to /login', async () => {
      const form = new URLSearchParams({
        db_host: 'wizard-host', db_port: '3306', db_user: 'wizard-user', db_password: 'wizard-db-pass',
        db_name: 'vmpanel', admin_username: 'owner', admin_password: 'twelve-chars-minimum!',
        admin_password_confirm: 'twelve-chars-minimum!', steam_api_key: '', _csrf: csrfToken,
      }).toString();
      const r = await request('POST', '/install', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
        body: form,
      });
      assert.strictEqual(r.status, 302);
      assert.strictEqual(r.headers.location, '/login');
      const written = fs.readFileSync(httpEnv, 'utf8');
      assert.ok(written.includes('SETUP_COMPLETE=true'));
      assert.ok(!written.includes('twelve-chars-minimum'));
    });
    await ok('wizard GET /install 404s after completion', async () => {
      const r = await request('GET', '/install');
      assert.strictEqual(r.status, 404);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mysqlPromise.createConnection = origCreateConnection;
    dbBridge.query = origQuery;
    install.resetInstallState();
  }

  for (const line of results) console.log(line);
  console.log(`\n${pass} install tests passed${fail ? ` (${fail} FAILURES)` : ''}`);
  // Never leave tmp .env pointers behind for other suites.
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error('install test harness error:', e);
  process.exitCode = 1;
});
