'use strict';
// Smoke tests: no DB required. Run: node tests/smoke.js
const assert = require('assert');
let pass = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log(`  ok - ${name}`); } catch (e) { console.error(`  FAIL - ${name}: ${e.message}`); process.exitCode = 1; } };

// 1. SteamID converter round-trips
const Conv = require('../app/utils/steamIdConvertor');
ok('steam64 -> steamID', () => assert.strictEqual(Conv.toSteamID('76561197960265730'), 'STEAM_1:0:1'));
ok('isSteamID valid', () => assert.ok(Conv.isSteamID('STEAM_1:0:123456')));
ok('isSteamID rejects garbage', () => assert.ok(!Conv.isSteamID('STEAM_1:0:abc; DROP')));
ok('isSteamID64 valid', () => assert.ok(Conv.isSteamID64('76561198012345678')));
ok('isSteamID3 valid', () => assert.ok(Conv.isSteamID3('[U:1:123456]')));
ok('fromSteamID3', () => assert.strictEqual(Conv.fromSteamID3('[U:1:246913]'), 'STEAM_0:1:123456'));

// 2. Gift recipient normalization mirrors userDashboard logic
function normalizeRecipient(raw) {
  const s = String(raw || '').trim();
  if (Conv.isSteamID(s)) return s;
  if (Conv.isSteamID64(s)) return Conv.toSteamID(s);
  if (Conv.isSteamID3(s)) return Conv.fromSteamID3(s);
  throw new Error('Invalid recipient SteamID format');
}
ok('gift normalize STEAM_', () => assert.strictEqual(normalizeRecipient('STEAM_1:0:123456'), 'STEAM_1:0:123456'));
ok('gift normalize 64', () => assert.strictEqual(normalizeRecipient('76561197960265730'), 'STEAM_1:0:1'));
ok('gift normalize STEAM3', () => assert.strictEqual(normalizeRecipient('[U:1:246913]'), 'STEAM_0:1:123456'));
ok('gift rejects injection', () => assert.throws(() => normalizeRecipient('STEAM_1:0:1"; DROP TABLE x;--')));

// 3. Client gift regex mirrors server (myDashboard vmpGetGiftFields)
const GIFT_RE = /^(STEAM_[0-5]:[01]:\d{1,12}|\d{17}|\[U:1:\d{1,12}\])$/;
ok('client regex accepts STEAM_', () => assert.ok(GIFT_RE.test('STEAM_1:0:123456')));
ok('client regex rejects SQLi', () => assert.ok(!GIFT_RE.test('STEAM_1:0:1" OR "1"="1')));

// 4. Table-name allowlist mirrors vipModel
const TABLE_RE = /^[A-Za-z0-9_]{1,64}$/;
ok('table allowlist accepts sv_1', () => assert.ok(TABLE_RE.test('sv_server1')));
ok('table allowlist rejects injection', () => assert.ok(!TABLE_RE.test('sv1; DROP TABLE tbl_users;--')));
ok('table allowlist rejects backticks', () => assert.ok(!TABLE_RE.test('`tbl_users`')));

// 5. Pagination coercion mirrors sales/audit models
const coerce = (v, d) => Math.min(Math.max(parseInt(v, 10) || d, 1), 100);
ok('pagination parses leading int safely (bound param, no SQL)', () => assert.strictEqual(coerce('1; DROP TABLE', 10), 1));
ok('pagination defaults garbage to default', () => assert.strictEqual(coerce('abc', 10), 10));
ok('pagination caps at 100', () => assert.strictEqual(coerce('99999', 10), 100));

// 6. RCON/ban validators mirror sourceBans
ok('ban length allowlist', () => assert.ok(new Set(['0','30','60','1440','10080','43200']).has('1440')));
ok('ban length rejects 99999', () => assert.ok(!new Set(['0','30','60','1440','10080','43200']).has('99999; rm -rf')));
ok('steam regex rejects gag pipe trick', () => assert.ok(!/^STEAM_[0-5]:[01]:\d{1,12}$/.test('STEAM_1:0:1|hacker')));

// 7. safeError never leaks SQL
const { sendSafeError } = require('../app/utils/safeError');
ok('safeError masks SQL errors', () => {
  let out = null; const res = { status: (c) => ({ json: (b) => { out = { c, b }; } }) };
  sendSafeError({ uuid: 't-1', method: 'GET', originalUrl: '/x' }, res, new Error('SELECT * FROM tbl_users WHERE 1=1; ER_BAD_FIELD'), 'FB');
  assert.strictEqual(out.c, 500); assert.strictEqual(out.b.data.message, 'FB'); assert.strictEqual(out.b.data.requestId, 't-1');
});
ok('safeError passes friendly messages', () => {
  let out = null; const res = { status: (c) => ({ json: (b) => { out = { c, b }; } }) };
  sendSafeError({ uuid: 't-2', method: 'POST', originalUrl: '/y' }, res, 'Price mismatch, please retry', 'FB');
  assert.strictEqual(out.b.data.message, 'Price mismatch, please retry');
});

// 8. Config loads without config.json (env fallback to example)
ok('config loads + env override', () => {
  process.env.DB_NAME = 'smoke_db';
  delete require.cache[require.resolve('../app/config')];
  const cfg = require('../app/config');
  assert.strictEqual(cfg.db.db_name, 'smoke_db');
  delete process.env.DB_NAME;
});

// 9. Auth middleware loads + handles missing referer/token without throwing sync
ok('auth middleware null-safe', () => {
  const auth = require('../app/middleWares/auth');
  assert.ok(typeof auth.checkToken === 'function' && typeof auth.requireSuperAdmin === 'function');
  const req = { session: {}, headers: {}, body: {}, route: { path: '/managevip' } };
  const res = { render: () => {} };
  auth.checkToken(req, res, () => {}); // must not throw on missing referer
});

// 10. Gift recipient input normalization (pure, no network)
ok('gift normalize vanity URL', () => {
  const g = require('../app/controllers/giftRecipient');
  const n = g.normalizeInput('https://steamcommunity.com/id/shaikhnedab/');
  assert.strictEqual(n.kind, 'url');
  assert.ok(n.profileUrl.includes('/id/shaikhnedab'));
});
ok('gift normalize profiles URL', () => {
  const g = require('../app/controllers/giftRecipient');
  const n = g.normalizeInput('http://steamcommunity.com/profiles/76561198092023766');
  assert.strictEqual(n.profileUrl, 'https://steamcommunity.com/profiles/76561198092023766');
});
ok('gift normalize raw IDs', () => {
  const g = require('../app/controllers/giftRecipient');
  assert.strictEqual(g.normalizeInput('STEAM_1:0:123456').steamId, 'STEAM_1:0:123456');
  assert.strictEqual(g.normalizeInput('76561198092023766').steamId64, '76561198092023766');
  assert.strictEqual(g.normalizeInput('[U:1:131717888]').steamId, 'STEAM_1:0:65858944');
});
ok('gift rejects evil/non-steam input', () => {
  const g = require('../app/controllers/giftRecipient');
  assert.throws(() => g.normalizeInput('https://evil.com/id/x'));
  assert.throws(() => g.normalizeInput('not a steam thing'));
  assert.throws(() => g.normalizeInput(''));
});
ok('gift parses Steam XML string', () => {
  const g = require('../app/controllers/giftRecipient');
  const p = g.parseProfileXml('<profile><steamID64>76561198092023766</steamID64><steamID><![CDATA[Shaikh Kebab]]></steamID><avatarMedium><![CDATA[https://avatars.akamai.steamstatic.com/x_medium.jpg]]></avatarMedium></profile>');
  assert.strictEqual(p.steamId64, '76561198092023766');
  assert.strictEqual(p.personaName, 'Shaikh Kebab');
});

// 11. CSRF middleware behavior
ok('csrf mints + verifies session token', () => {
  const csrf = require('../app/middleWares/csrf');
  const make = () => ({ session: {}, headers: {}, body: {} });
  // mint
  const req1 = make();
  const res1 = { locals: {} };
  csrf.ensureCsrf(req1, res1, () => {});
  assert.ok(req1.session.csrfToken && req1.session.csrfToken.length >= 32);
  assert.strictEqual(res1.locals.csrfToken, req1.session.csrfToken);
  // accept valid (header)
  const req2 = { session: { csrfToken: req1.session.csrfToken }, method: 'POST', headers: { 'x-csrf-token': req1.session.csrfToken }, body: {} };
  let called = false;
  csrf.verifyCsrf(req2, null, () => { called = true; });
  assert.ok(called);
  // reject invalid
  const req3 = { session: { csrfToken: req1.session.csrfToken }, method: 'POST', headers: {}, body: { _csrf: 'wrong' } };
  const res3 = { status: (c) => ({ json: () => { assert.strictEqual(c, 403); } }) };
  csrf.verifyCsrf(req3, res3, () => { throw new Error('should not next'); });
  // safe methods pass
  const req4 = { method: 'GET', session: { csrfToken: 'x' }, headers: {}, body: {} };
  let called4 = false;
  csrf.verifyCsrf(req4, null, () => { called4 = true; });
  assert.ok(called4);
});

// 12. Request logger URI scrubbing
ok('request logger scrubs secrets in query strings', () => {
  const requestLogger = require('../app/middleWares/requestLogger');
  const scrubbed = requestLogger.scrubUrl('/auth/steam/return?openid.sig=abc&token=SECRET&x=1');
  assert.ok(scrubbed.includes('token=REDACTED'));
  assert.ok(!scrubbed.includes('SECRET'));
  assert.strictEqual(typeof requestLogger, 'function');
});

// 13. withTransaction exists + shape
ok('db bridge exposes transaction helper', () => {
  const db = require('../app/db/db_bridge');
  assert.strictEqual(typeof db.withTransaction, 'function');
  assert.strictEqual(typeof db.normalize, 'function');
});

// 14. migrate runner exists + migrations dir present
ok('migrate runner + migrations exist', () => {
  const fs = require('fs');
  const path = require('path');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'app', 'db', 'migrate.js')));
  const dir = fs.readdirSync(path.join(__dirname, '..', 'app', 'db', 'migrations'));
  assert.ok(dir.some((f) => f.endsWith('.sql')));
});

console.log(`\n${pass} smoke tests passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
