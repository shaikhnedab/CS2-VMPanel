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
  await ok('install token accepts a fresh token', () => {
    const { mintInstallToken, verifyInstallToken } = require('../app/utils/installToken');
    assert.strictEqual(verifyInstallToken(mintInstallToken()), true);
  });
  await ok('install token rejects tampered / malformed / expired tokens', () => {
    const { mintInstallToken, verifyInstallToken, WINDOW_MS } = require('../app/utils/installToken');
    const fresh = mintInstallToken();
    const tampered = fresh.slice(0, -1) + (fresh.endsWith('0') ? '1' : '0');
    assert.strictEqual(verifyInstallToken(tampered), false);
    assert.strictEqual(verifyInstallToken('not-a-token'), false);
    assert.strictEqual(verifyInstallToken(''), false);
    assert.strictEqual(verifyInstallToken(null), false);
    assert.strictEqual(verifyInstallToken(mintInstallToken(), 0 - 1), false); // negative window
    const expired = mintInstallToken(Date.now() - WINDOW_MS - 1000);
    assert.strictEqual(verifyInstallToken(expired), false);
    const future = mintInstallToken(Date.now() + 10 * 60 * 1000);
    assert.strictEqual(verifyInstallToken(future), false);
  });

  // ---- 1b. Steam OpenID + profile lookup (no network) ----
  await ok('steam OpenID URLs follow the request host, not static config', () => {
    const { steamBaseUrl, steamReturnUrl, steamRealm, buildSteamStrategy } = require('../app/utils/steamOpenId');
    const req = { protocol: 'http', get: (h) => (h === 'host' ? 'panel.example.com:3535' : undefined) };
    assert.strictEqual(steamBaseUrl(req), 'http://panel.example.com:3535');
    assert.strictEqual(steamReturnUrl(req), 'http://panel.example.com:3535/auth/steam/return');
    assert.strictEqual(steamRealm(req), 'http://panel.example.com:3535/');
    const tls = { protocol: 'https', get: () => 'vip.example.com' };
    assert.strictEqual(steamReturnUrl(tls), 'https://vip.example.com/auth/steam/return');
    assert.strictEqual(steamBaseUrl({}), 'http://localhost');
    assert.strictEqual(buildSteamStrategy('http://h:3535/auth/steam/return', 'http://h:3535/', '').name, 'steam');
  });
  await ok('public base URL normalizer accepts host forms, rejects the rest', () => {
    const { normalizePublicBaseUrl } = require('../app/utils/steamOpenId');
    assert.strictEqual(normalizePublicBaseUrl('https://vip.example.com/'), 'https://vip.example.com');
    assert.strictEqual(normalizePublicBaseUrl('http://host:3535'), 'http://host:3535');
    assert.strictEqual(normalizePublicBaseUrl('vip.example.com'), 'http://vip.example.com');
    assert.strictEqual(normalizePublicBaseUrl('  https://h.example/  '), 'https://h.example');
    for (const bad of ['', null, undefined, 'ftp://h', 'https://h/path', 'https://h?q=1', 'https://h#x', 'http://user@h', 'javascript:alert(1)', 'not a host!!', 'x'.repeat(300)]) {
      assert.strictEqual(normalizePublicBaseUrl(bad), null, `rejects: ${String(bad).slice(0, 30)}`);
    }
  });
  await ok('explicit PUBLIC_BASE_URL wins, invalid falls back to request', () => {
    const config = require('../app/config');
    const { steamBaseUrl, steamReturnUrl } = require('../app/utils/steamOpenId');
    const saved = config.publicBaseUrl;
    const req = { protocol: 'http', get: () => 'other.example.com:3535' };
    try {
      config.publicBaseUrl = 'https://vip.example.com/';
      assert.strictEqual(steamBaseUrl(req), 'https://vip.example.com');
      assert.strictEqual(steamReturnUrl(req), 'https://vip.example.com/auth/steam/return');
      config.publicBaseUrl = 'https://evil.example/pwn';
      assert.strictEqual(steamBaseUrl(req), 'http://other.example.com:3535');
      config.publicBaseUrl = '';
      assert.strictEqual(steamBaseUrl(req), 'http://other.example.com:3535');
    } finally {
      config.publicBaseUrl = saved;
    }
  });
  await ok('wizard validation accepts/normalizes/rejects public address', () => {
    const { validateInstallBody } = install;
    const good = () => ({
      db_host: 'h', db_port: '3306', db_user: 'u', db_password: 'p', db_name: 'd',
      admin_username: 'owner', admin_password: 'twelve-chars-minimum!',
      admin_password_confirm: 'twelve-chars-minimum!', steam_api_key: '', public_base_url: '',
    });
    let r = validateInstallBody(good());
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.values.publicBaseUrl, '');
    const withUrl = good(); withUrl.public_base_url = 'https://vip.example.com/';
    r = validateInstallBody(withUrl);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.values.publicBaseUrl, 'https://vip.example.com');
    for (const bad of ['ftp://h', 'https://h/path?q=1', 'not a host!!']) {
      const b = good(); b.public_base_url = bad;
      const rb = validateInstallBody(b);
      assert.ok(rb.errors.some((e) => /Public address/i.test(e)), `rejects ${bad}`);
    }
  });
  await ok('steam getProfile rejects junk input without network', async () => {
    const Steam = require('../app/modules/steam');
    const steam = new Steam();
    // Rejections are {type:'actor',desc} objects, not Errors — inspect desc.
    const fails = async (input) => steam.getProfile(input).then(() => null, (e) => e);
    assert.ok(/profile link/i.test((await fails('not a steam link!!!') || {}).desc || ''));
    assert.ok(/Enter a Steam profile/i.test((await fails('') || {}).desc || ''));
    assert.ok(/Enter a Steam profile/i.test((await fails(null) || {}).desc || ''));
  });
  await ok('steam getProfile explains missing API key for bare names', async () => {
    if (require('../app/config').steam_api_key) return; // real key: would hit network, skip
    delete process.env.STEAM_API_KEY;
    const Steam = require('../app/modules/steam');
    const err = await new Steam().getProfile('somevanityname').then(() => null, (e) => e);
    assert.ok(/API key/i.test((err || {}).desc || ''));
  });
  await ok('profile lookup maps bad URLs to friendly errors', async () => {
    const { fetchProfileData } = require('../app/controllers/steamProfileDataFetch');
    let payload = null;
    await fetchProfileData({ body: { profileUrl: 'not a steam link!!!' } }, { json: (o) => { payload = o; } });
    assert.strictEqual(payload.success, false);
    assert.ok(/profile link|profile URL/i.test(payload.data.error), `friendly message, got: ${payload.data.error}`);
  });
  await ok('profile lookup frontend guards error responses', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'steamIdFinder.js'), 'utf8');
    assert.ok(js.includes('response.success !== true'), 'checks success flag before parsing');
  });
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
  await ok('envWriter falls back to in-place copy when rename hits EBUSY (bind mount)', () => {
    // Simulate `./.env:/app/.env`: rename onto the mountpoint fails, the copy
    // must carry the content through and clean up the temp file.
    const origRename = fs.renameSync;
    const busy = new Error('resource busy or locked, rename');
    busy.code = 'EBUSY';
    fs.renameSync = () => { throw busy; };
    try {
      const target = envWriter.writeEnv({ INSTALL_TEST_MOUNT: 'through-the-mount' });
      const content = fs.readFileSync(target, 'utf8');
      assert.ok(content.includes('INSTALL_TEST_MOUNT=through-the-mount'));
      const leftovers = fs.readdirSync(path.dirname(target)).filter((f) => f.startsWith('.env.tmp-'));
      assert.deepStrictEqual(leftovers, []);
    } finally {
      fs.renameSync = origRename;
    }
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
  await ok('migration 001 avoids MariaDB-only IF NOT EXISTS (MySQL syntax)', () => {
    const sql001 = fs.readFileSync(path.join(__dirname, '..', 'app', 'db', 'migrations', '001_indexes_gifting.sql'), 'utf8');
    const executable = sql001.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    assert.ok(!/IF NOT EXISTS/i.test(executable), '001 must parse on MySQL');
  });
  await ok('migration 003 backfills server columns, one ADD per statement', () => {
    const sql003 = fs.readFileSync(path.join(__dirname, '..', 'app', 'db', 'migrations', '003_legacy_server_columns.sql'), 'utf8');
    const stmts = sql003.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
      .split(';').map((s) => s.trim()).filter((s) => s.length > 0);
    assert.ok(stmts.length >= 5, '003 covers the panel-managed server columns');
    for (const s of stmts) {
      assert.ok(/^ALTER TABLE `\w+` ADD COLUMN `\w+`/.test(s), `single portable ADD COLUMN, got: ${s.slice(0, 60)}`);
      assert.ok(!/IF NOT EXISTS/i.test(s), 'MySQL has no ADD COLUMN IF NOT EXISTS');
    }
    assert.ok(stmts.some((s) => s.includes('`server_rcon_pass`')), '003 repairs the reported rcon column');
  });
  await ok('server-picker dropdowns are CSS-anchored under their buttons', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'vmp-design-system.css'), 'utf8');
    assert.ok(css.includes('.server-picker > .dropdown-menu.show'), 'anchor rule present');
    assert.ok(/\.server-picker > \.dropdown-menu\.show\s*\{[^}]*transform:\s*none !important/.test(css), 'Popper offsets neutralized');
    for (const view of ['ManageVIP.ejs', 'ManageAdmin.ejs']) {
      const html = fs.readFileSync(path.join(__dirname, '..', 'views', view), 'utf8');
      assert.ok(html.includes('dropdown server-picker'), `${view} marks its picker`);
    }
  });
  await ok('migration 004 adds per-server rcon refresh command', () => {
    const sql004 = fs.readFileSync(path.join(__dirname, '..', 'app', 'db', 'migrations', '004_server_rcon_refresh_cmd.sql'), 'utf8');
    const stmts = sql004.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
      .split(';').map((s) => s.trim()).filter((s) => s.length > 0);
    assert.strictEqual(stmts.length, 1);
    assert.ok(/^ALTER TABLE `\w+` ADD COLUMN `rcon_refresh_cmd` varchar\(100\)/i.test(stmts[0]), 'single portable ADD COLUMN');
    assert.ok(/DEFAULT NULL/i.test(stmts[0]), 'NULL default preserves legacy behavior');
  });
  await ok('refresh command resolves per server, legacy default otherwise', () => {
    const { refreshCommandFor, DEFAULT_REFRESH_CMD } = require('../app/utils/refreshCFGInServer');
    assert.strictEqual(DEFAULT_REFRESH_CMD, 'css_viprefresh');
    assert.strictEqual(refreshCommandFor({ rcon_refresh_cmd: 'fake_rcon css_viprefresh' }), 'fake_rcon css_viprefresh');
    assert.strictEqual(refreshCommandFor({ rcon_refresh_cmd: 'sm_vipRefresh' }), 'sm_vipRefresh');
    assert.strictEqual(refreshCommandFor({ rcon_refresh_cmd: '  css_viprefresh  ' }), 'css_viprefresh');
    for (const missing of [{}, { rcon_refresh_cmd: null }, { rcon_refresh_cmd: '' }, { rcon_refresh_cmd: '   ' }, null, undefined]) {
      assert.strictEqual(refreshCommandFor(missing), 'css_viprefresh');
    }
  });
  await ok('server add/update rejects unsafe refresh commands before DB', async () => {
    const { addPanelServerFunc } = require('../app/controllers/panelServers');
    const fails = async (cmd) => addPanelServerFunc({ tablename: 'sv_x', servername: 'X', serverrconcmd: cmd }, 'u')
      .then(() => null, (e) => String(e));
    for (const bad of ['sm_vipRefresh; reboot', 'a`b', 'x'.repeat(101), 'cmd$(x)', 'a|b', 'a"b']) {
      const err = await fails(bad);
      assert.ok(/RCON refresh command/i.test(err || ''), `rejects: ${String(bad).slice(0, 20)}`);
    }
    // Valid + blank commands pass validation (fail later at DB, which is unstubbed here);
    // stray newlines/tabs are collapsed to spaces, still valid.
    for (const good of ['fake_rcon css_viprefresh', 'sm_vipRefresh', '', null, 'a\nb']) {
      const err = await fails(good);
      assert.ok(err && !/RCON refresh command/i.test(err), `passes validation: ${String(good)}`);
    }
  });
  await ok('runMigrations tolerates already-exists errors, fails others', async () => {
    const dupKey = Object.assign(new Error('dup'), { code: 'ER_DUP_KEYNAME', errno: 1061 });
    const dupField = Object.assign(new Error('dup'), { code: 'ER_DUP_FIELDNAME', errno: 1060 });
    const calls = [];
    const fakeQuery = async (sql) => {
      calls.push(String(sql));
      if (/SELECT filename/i.test(String(sql))) return [];
      if (/SCHEMA_MIGRATIONS/i.test(String(sql)) && !/INSERT/i.test(String(sql))) return { affectedRows: 1 };
      if (calls.length % 2 === 0 && !/INSERT INTO `?schema_migrations/i.test(String(sql))) {
        throw (calls.length % 4 === 0) ? dupKey : dupField;
      }
      return { affectedRows: 1 };
    };
    const ran = await runMigrations(fakeQuery);
    assert.ok(ran >= 1, 'partial applies converge instead of throwing');
    const badQuery = async (sql) => {
      if (/SELECT filename/i.test(String(sql))) return [];
      const e = Object.assign(new Error('syntax'), { code: 'ER_PARSE_ERROR', errno: 1064 });
      throw e;
    };
    await assert.rejects(() => runMigrations(badQuery), /syntax/);
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
    let noCookieToken = null;
    await ok('wizard test-connection works with cookies blocked (stateless CSRF)', async () => {
      jar = []; // simulate a browser that drops all cookies
      const g = await request('GET', '/install');
      assert.strictEqual(g.status, 200);
      noCookieToken = extractCsrf(g.body);
      assert.ok(noCookieToken && noCookieToken.length >= 32);
      jar = []; // drop the Set-Cookie from the GET too: POST carries no Cookie header
      const payload = JSON.stringify({ db_host: 'h', db_port: 3306, db_user: 'u', db_password: 'p', db_name: 'vmpanel', _csrf: noCookieToken });
      const r = await request('POST', '/install/test-connection', {
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': noCookieToken, 'Content-Length': Buffer.byteLength(payload) },
        body: payload,
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(JSON.parse(r.body).success, true);
      jar = []; // stay cookie-less; remaining wizard POSTs must not need cookies either
    });
    await ok('wizard test-connection answers JSON 429 when over budget', async () => {
      let last = null;
      for (let i = 0; i < 40 && (!last || last.status !== 429); i++) {
        const payload = JSON.stringify({ db_host: 'h', db_port: 3306, db_user: 'u', db_password: 'p', db_name: 'vmpanel', _csrf: noCookieToken });
        last = await request('POST', '/install/test-connection', {
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': noCookieToken, 'Content-Length': Buffer.byteLength(payload) },
          body: payload,
        });
      }
      assert.strictEqual(last.status, 429);
      assert.strictEqual(JSON.parse(last.body).success, false);
      assert.ok(/too many attempts/i.test(JSON.parse(last.body).data.message));
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
    await ok('wizard submit renders friendly 429 when over budget', async () => {
      // Needs a fresh app: the main server's submit budget is reserved for the
      // success test, and this runs after completion. Temporarily flip setup
      // back to incomplete so the gate lets POSTs reach the limiter.
      install.resetInstallState();
      const httpEnvBak = process.env.DOTENV_PATH;
      for (const k of ['SETUP_COMPLETE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET', 'APP_SESSION_SECRET', 'STEAM_API_KEY']) delete process.env[k];
      process.env.DOTENV_PATH = path.join(tmpDir, 'incomplete.env');
      try { fs.unlinkSync(process.env.DOTENV_PATH); } catch (e) { /* absent */ }
      const app2 = createApp();
      const server2 = await new Promise((resolve) => {
        const s = app2.listen(0, () => resolve(s));
      });
      const port2 = server2.address().port;
      const request2 = (method, reqPath, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: port2, path: reqPath, method, headers: { ...headers } }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        if (body !== null) req.write(body);
        req.end();
      });
      try {
        const g = await request2('GET', '/install');
        assert.strictEqual(g.status, 200);
        const tok2 = extractCsrf(g.body);
        assert.ok(tok2 && tok2.length >= 32);
        let last = null;
        for (let i = 0; i < 14 && (!last || last.status !== 429); i++) {
          const form = new URLSearchParams({
            db_host: 'h', db_port: '3306', db_user: 'u', db_password: 'p', db_name: 'vmpanel',
            admin_username: 'owner', admin_password: 'short', admin_password_confirm: 'short',
            steam_api_key: '', _csrf: tok2,
          }).toString();
          last = await request2('POST', '/install', {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
            body: form,
          });
        }
        assert.strictEqual(last.status, 429);
        assert.ok(/too many attempts/i.test(last.body));
        assert.ok(!/s3cret|supersecret/i.test(last.body));
      } finally {
        await new Promise((resolve) => server2.close(resolve));
        process.env.DOTENV_PATH = httpEnvBak;
        install.resetInstallState();
      }
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
