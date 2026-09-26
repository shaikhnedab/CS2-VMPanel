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

// Isolate dotenv + config file before any app module loads.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-install-'));
process.env.DOTENV_PATH = path.join(tmpDir, 'test.env');
process.env.CONFIG_PATH = path.join(tmpDir, 'test-config.json');

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
  await ok('authIdMatchAll covers quoted/bare x 64/legacy spellings', () => {
    const C = require('../app/utils/steamIdConvertor');
    assert.deepStrictEqual(C.authIdMatchAll('STEAM_1:0:65879019'), [
      '"76561198092023766"', '76561198092023766', '"STEAM_1:0:65879019"', 'STEAM_1:0:65879019',
    ]);
    // quoted input, ID3, and bare account id all canonicalize to the same set
    for (const input of ['"STEAM_1:0:65879019"', '[U:1:131758038]', '76561198092023766']) {
      assert.deepStrictEqual(C.authIdMatchAll(input), C.authIdMatchAll('STEAM_1:0:65879019'), `same set for ${input}`);
    }
  });
  await ok('dashboard lookup matches bare plugin-written rows (stubbed DB)', async () => {
    const dbBridge = require('../app/db/db_bridge');
    const origQuery = dbBridge.query;
    const seen = [];
    dbBridge.query = async (sql) => {
      const q = String(sql);
      seen.push(q);
      if (/FROM tbl_servers/i.test(q)) return [{ tbl_name: 'sv_test', server_name: 'Test Server' }];
      if (/FROM sv_test/i.test(q)) return [{ authId: '76561198092023767', name: 'Bare', expireStamp: 9999999999, created_at: new Date(), type: 0 }];
      return [];
    };
    try {
      const m = require('../app/models/myDashboardModel');
      const r = await m.getUserDataFromAllServers('"STEAM_1:0:65879020"');
      assert.strictEqual(r.length, 1);
      assert.strictEqual(r[0].data.authId, '76561198092023767');
      const asked = seen.find((q) => /FROM sv_test/i.test(q));
      // mysql2 sends `"` as `\"` on the wire; MySQL unescapes on receipt
      // (proven by the live-DB MATCH runs) — compare the unescaped intent.
      const unescaped = asked.replace(/\\"/g, '"');
      for (const v of ['"76561198092023768"', '76561198092023768', '"STEAM_1:0:65879020"', 'STEAM_1:0:65879020']) {
        assert.ok(unescaped.includes(v), `query covers ${v}`);
      }
    } finally {
      dbBridge.query = origQuery;
    }
  });
  await ok('myDashboardFunc survives minimal Steam profile (no photos/_json)', async () => {
    const dbBridge = require('../app/db/db_bridge');
    const origQuery = dbBridge.query;
    dbBridge.query = async () => [];
    try {
      const { myDashboardFunc } = require('../app/controllers/userDashboard');
      const r = await myDashboardFunc({}, { id: '76561198092023766' });
      assert.strictEqual(r.userData.displayname, '76561198092023766');
      assert.strictEqual(r.userData.avatarUrl, '');
      assert.deepStrictEqual(r.userDataListing, []);
    } finally {
      dbBridge.query = origQuery;
    }
  });
  await ok('httpGet: rejects bad input, bounds time, parses json, no needle', async () => {
    const fsx = require('fs');
    const pathx = require('path');
    const { httpGet } = require('../app/utils/httpGet');
    await assert.rejects(() => httpGet(null), TypeError);
    await assert.rejects(() => httpGet('not-a-url'), TypeError);
    await assert.rejects(() => httpGet('ftp://host/x'), TypeError);
    // Local server: json + non-200 + timeout behaviour, no external network.
    const http = require('http');
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/slow')) return; // never responds
      if (req.url.startsWith('/bad')) { res.statusCode = 500; res.end('{"e":1}'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      const good = await httpGet(`http://127.0.0.1:${port}/p`, { params: { a: 'x y', b: 2 } });
      assert.strictEqual(good.ok, true);
      assert.strictEqual(good.body.ok, true);
      assert.ok(/a=x\+y/.test(good.body.path), 'params encoded: ' + good.body.path);
      assert.ok(/b=2/.test(good.body.path));
      const bad = await httpGet(`http://127.0.0.1:${port}/bad`);
      assert.strictEqual(bad.ok, false);
      assert.strictEqual(bad.statusCode, 500);
      const t0 = Date.now();
      const slow = await httpGet(`http://127.0.0.1:${port}/slow`, { timeout: 400 });
      assert.strictEqual(slow.ok, false);
      assert.ok(/timed out/i.test(slow.error || ''), 'timeout reported: ' + slow.error);
      assert.ok(Date.now() - t0 < 3000, 'timeout honoured');
    } finally {
      await new Promise((r) => srv.close(r));
    }
    // Regression guard: no steam call site may use needle's params-object form.
    for (const rel of ['app/modules/steam.js', 'app/utils/steamOpenId.js']) {
      const src = fsx.readFileSync(pathx.join(__dirname, '..', rel), 'utf8');
      assert.ok(!/require\(['"]needle['"]\)/.test(src), `${rel} no longer imports needle`);
    }
  });
  await ok('real steam API reachable via httpGet (name resolves, no crash)', async () => {
    const { httpGet } = require('../app/utils/httpGet');
    const res = await httpGet('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/', {
      params: { key: 'C32B5A70B2A13049D5E6938AC8B956ED', steamids: '76561198092023766' },
      timeout: 8000,
    });
    assert.ok(res.ok, 'steam api reachable: ' + (res.error || res.statusCode));
    const p = res.body && res.body.response && res.body.response.players[0];
    assert.ok(p && p.personaname, 'personaname present -> nav shows a name, not the id');
  });
  await ok('owned servers keep a gift path instead of vanishing', async () => {
    const dbBridge = require('../app/db/db_bridge');
    const origQuery = dbBridge.query;
    dbBridge.query = async (sql) => {
      const q = String(sql).replace(/\s+/g, ' ');
      // singleRecord=true returns one row, not an array
      if (/COUNT\(authId\)/i.test(q)) return { usercount: '1' };
      if (/FROM `?tbl_servers`?/i.test(q)) return [{ tbl_name: 'sv_t', server_name: 'Mine', server_ip: '', server_port: '', vip_slots: 10, vip_price: 30, vip_currency: 'USD', vip_days: 30 }];
      if (/FROM `?sv_t`?\b/i.test(q)) return [{ authId: '76561198092023766', name: 'Me', expireStamp: 1792079631, created_at: new Date(), type: 0 }];
      return [];
    };
    try {
      const { myDashboardFunc } = require('../app/controllers/userDashboard');
      const r = await myDashboardFunc({}, { id: '76561198092023766', displayName: 'Me' });
      assert.strictEqual(r.serverArray.length, 1, 'owned server still listed');
      assert.strictEqual(r.serverArray[0].vmpOwned, true, 'flagged as owned');
    } finally {
      dbBridge.query = origQuery;
    }
  });
  await ok('store: owned cards offer gift, unowned offer buy', () => {
    const ejsMod = require('ejs');
    // Drop the Header/Footer partials and render without a filename: partial
    // includes resolve relative to the template filename, and ejs keys its
    // compile cache by filename+source, so an earlier render elsewhere in this
    // suite could otherwise hand back a stale compiled view.
    const source = fs.readFileSync(path.join(__dirname, '..', 'views', 'UserDashboard.ejs'), 'utf8')
      .replace(/<%-\s*include\('(?:Header|Footer)\.ejs'\)\s*%>/g, '');
    const render = (owned) => ejsMod.render(source, {
      panelSetting: { community_name: 'T', color_theme: 'primary', platform_currency: 'USD', community_logo_url: '' },
      currentURL: '/mydashboard', csrfToken: 'x', sessionToken: null, adminType: 0,
      sessionSteamId: '76561198092023766', adminName: null, steamName: 'Me',
      userData: { steamId: '76561198092023766', displayname: 'Me', realName: '', avatarUrl: '' },
      userDataListing: [{ servername: 'Mine', data: { authId: '76561198092023766', name: 'Me', expireStamp: 1792079631, type: 0 }, serverdata: { tbl_name: 'sv_t' } }],
      serverArray: [{ tbl_name: 'sv_t', server_name: 'Mine', vip_price: 30, vip_currency: 'USD', vip_days: 30, vmpOwned: owned }],
      bundleArray: [], paypalActive: true, paypalClientID: 'test-client-id', payuActive: false, payuEnv: 'test',
      razorpayActive: false, giftingActive: true, colSpan: '12',
    });
    const ownedHtml = render(true);
    assert.ok(ownedHtml.includes('data-buytype="giftPurchase"'), 'owned -> gift path');
    assert.ok(!ownedHtml.includes('data-buytype="newPurchase"'), 'owned -> no buy path');
    assert.ok(render(false).includes('data-buytype="newPurchase"'), 'unowned -> buy path');
    assert.ok(ownedHtml.includes('You already hold VIP here'), 'owned card explains itself');
  });
  await ok('header falls back to a label, never a blank steam name', () => {
    const hdr = fs.readFileSync(path.join(__dirname, '..', 'views', 'Header.ejs'), 'utf8');
    assert.ok(/steamName\|\|'Steam user'/.test(hdr), 'steam name fallback present');
  });
  await ok('steam profile fetch falls back without apiKey (bounded, offline-safe)', async () => {
    const { parseSteamId64, fetchSteamProfile, minimalProfile } = require('../app/utils/steamOpenId');
    assert.strictEqual(parseSteamId64('https://steamcommunity.com/openid/id/76561198092023766'), '76561198092023766');
    assert.strictEqual(parseSteamId64('https://evil.com/openid/id/1'), null);
    assert.strictEqual(parseSteamId64(null), null);
    assert.deepStrictEqual(minimalProfile('76561198092023766').id, '76561198092023766');
    const t0 = Date.now();
    const p = await fetchSteamProfile('', '76561198092023766');
    assert.ok(Date.now() - t0 < 2000, 'no network attempted without key');
    assert.strictEqual(p.id, '76561198092023766');
    assert.ok(Array.isArray(p.photos));
  });
  await ok('steam strategy disables unbounded library profile fetch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'utils', 'steamOpenId.js'), 'utf8');
    assert.ok(/profile:\s*false/.test(src), 'profile:false is set');
    assert.ok(/require\('\.\/httpGet'\)/.test(src), 'uses the bounded httpGet helper');
    assert.ok(/timeout:\s*PROFILE_TIMEOUT_MS/.test(src), 'profile fetch timeout forwarded');
    const m = src.match(/PROFILE_TIMEOUT_MS\s*=\s*(\d+)/);
    assert.ok(m && Number(m[1]) > 0 && Number(m[1]) <= 30000, `timeout bounded: ${m && m[1]}ms`);
  });
  await ok('store defers third-party SDK scripts', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'UserDashboard.ejs'), 'utf8');
    for (const host of ['cdnjs.cloudflare.com/ajax/libs/crypto-js', 'www.paypal.com/sdk/js', 'citruspay.com/bolt', 'checkout.razorpay.com']) {
      const m = html.match(new RegExp(`<script[^>]*${host.replace(/\./g, '\\.')}[^>]*>`, 'g')) || [];
      assert.ok(m.length > 0, `${host} present`);
      assert.ok(m.every((t) => /\bdefer\b/.test(t)), `${host} deferred`);
    }
  });
  // The payment init controllers resolve the server row and price from OUR
  // database rather than the request, so tests must provide one.
  const withServerRow = async (row, fn) => {
    const panelServerModal = require('../app/models/panelServerModal.js');
    const orig = panelServerModal.getPanelServerDetails;
    panelServerModal.getPanelServerDetails = async () => (typeof row === 'function' ? row() : row);
    try { return await fn(); } finally { panelServerModal.getPanelServerDetails = orig; }
  };
  const INR_ROW = {
    tbl_name: 'sv_t', server_name: 'S', vip_price: 100, vip_currency: 'INR', vip_days: 30,
    vip_flag: '"0:a"', vip_slots: 30,
  };

  await ok('payU callbacks follow explicit base, else request host', async () => {
    const config = require('../app/config');
    const { initPayUPaymentFunc } = require('../app/controllers/payU');
    const saved = config.publicBaseUrl;
    const reqOf = (proto, host) => ({ protocol: proto, get: (h) => (h === 'host' ? host : undefined) });
    const formBody = {
      serverData: { tbl_name: 'sv_t', vip_days: 30, server_name: 'S', vip_price: 100, vip_currency: 'INR' },
      type: 'newPurchase', userFirstName: 'T', userEmail: 't@e.com', userMobile: '1',
    };
    try {
      await withServerRow(INR_ROW, async () => {
      config.publicBaseUrl = 'https://vip.example.com/';
      let r = await initPayUPaymentFunc(formBody, { id: '76561198092023766' }, 'k', reqOf('http', 'other.example:3535'));
      assert.strictEqual(r.surl, 'https://vip.example.com/txnsuccesspayu');
      assert.strictEqual(r.furl, 'https://vip.example.com/txnerrorpayu');
      config.publicBaseUrl = '';
      r = await initPayUPaymentFunc(formBody, { id: '76561198092023766' }, 'k', reqOf('http', 'panel.example.com:3535'));
      assert.strictEqual(r.surl, 'http://panel.example.com:3535/txnsuccesspayu');
      assert.strictEqual(r.furl, 'http://panel.example.com:3535/txnerrorpayu');
      assert.ok(!/undefined|localhost/.test(r.surl), 'no placeholder host leaks');
      });
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
  await ok('lookup autofill and gift badge show 64-bit ids', () => {
    const finder = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'steamIdFinder.js'), 'utf8');
    assert.ok(/let finalSteamID = steamID64;/.test(finder), 'autofill uses raw 64-bit id');
    assert.ok(!/finalSteamID = SteamIDConverter\.toSteamID\(/.test(finder), 'no STEAM_ downgrade on fill');
    const dash = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'myDashboard.js'), 'utf8');
    assert.ok(dash.includes('recipientSteamId = rid64'), 'gift submits verified 64-bit id');
    assert.ok(dash.includes('escHtml(rid64)'), 'gift badge displays 64-bit id');
  });
  await ok('vip and gift inputs hint 64-bit ids', () => {    const vip = fs.readFileSync(path.join(__dirname, '..', 'views', 'ManageVIP.ejs'), 'utf8');
    for (const id of ['steamId_add', 'steamId_update']) {
      assert.ok(new RegExp(`id="${id}"[^>]*value="7656119…"`).test(vip), `${id} defaults to 64-bit hint`);
    }
    assert.ok(!vip.includes('STEAM_X:Y:Z'), 'old STEAM_X placeholder gone from VIP forms');
    const dash = fs.readFileSync(path.join(__dirname, '..', 'views', 'UserDashboard.ejs'), 'utf8');
    assert.ok(/vmpGiftRecipient"[^>]*placeholder="[^"]*7656119…/.test(dash), 'gift input hints 64-bit');
    assert.ok(!/vmpGiftRecipient"[^>]*STEAM_X:Y:Z/.test(dash), 'gift placeholder drops the fake STEAM_X example');
  });
  await ok('placeholder paypal client ids count as unconfigured', () => {
    const { isRealPaypalClientId } = require('../app/controllers/userDashboard');
    for (const bad of ['', null, undefined, 'Your paypal client id here (Leave Empty to disable Paypal Feature)', 'change-me-paypal-id']) {
      assert.strictEqual(isRealPaypalClientId(bad), false);
    }
    assert.strictEqual(isRealPaypalClientId('AYaBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890'), true);
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
  // Setup flag lives in config.json now, but process.env still wins, so
  // legacy .env-only installs keep working. CONFIG_PATH points at a missing
  // file here, isolating the env-driven cases below.
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
    await ok('isSetupComplete true with complete env and no files', () => {
      try { fs.unlinkSync(matrixPath); } catch (e) { /* absent */ }
      setEnv({ SETUP_COMPLETE: 'true', DB_HOST: 'h', DB_USER: 'u', DB_NAME: 'd', JWT_SECRET: 'x'.repeat(32), APP_SESSION_SECRET: 'y'.repeat(32) });
      assert.strictEqual(config.isSetupComplete(), true);
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

  // ---- 3b. config.json writer + file/env precedence (no DB) ----
  await ok('configWriter round-trips nested config with 0600 perms', () => {
    const configWriter = require('../app/utils/configWriter');
    const target = configWriter.writeConfig({
      db_host: 'h', db_port: 3306, db_user: 'u', db_password: 'p', db_name: 'd',
      jwt_secret: 'x'.repeat(32), app_secret: 'y'.repeat(32),
      steam_api_key: '', public_base_url: 'https://vip.example.com/', setup_complete: false,
    });
    assert.strictEqual(target, process.env.CONFIG_PATH);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.strictEqual(parsed.db.db_host, 'h');
    assert.strictEqual(parsed.db.db_port, 3306);
    assert.strictEqual(parsed.jwt.key, 'x'.repeat(32));
    // Stored verbatim (normalization is the validator's job, not the writer's).
    assert.strictEqual(parsed.publicBaseUrl, 'https://vip.example.com/');
    assert.strictEqual(parsed.setupComplete, false);
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
  });
  await ok('configWriter merges (never clobbers hand-edited keys)', () => {
    const configWriter = require('../app/utils/configWriter');
    const target = process.env.CONFIG_PATH;
    const seeded = JSON.parse(fs.readFileSync(target, 'utf8'));
    seeded.payment_gateways = { payU: { merchantKey: 'keep-me' } };
    fs.writeFileSync(target, JSON.stringify(seeded));
    configWriter.writeConfig({ setup_complete: true });
    const merged = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.strictEqual(merged.setupComplete, true);
    assert.strictEqual(merged.payment_gateways.payU.merchantKey, 'keep-me');
    assert.strictEqual(merged.db.db_host, 'h');
  });
  await ok('configWriter falls back to example template on garbage', () => {    const configWriter = require('../app/utils/configWriter');
    const target = process.env.CONFIG_PATH;
    fs.writeFileSync(target, 'not json {{{');
    const out = configWriter.writeConfig({ setup_complete: false });
    assert.strictEqual(out, target);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.ok(parsed.db && typeof parsed.db.db_port !== 'undefined');
    try { fs.unlinkSync(target); } catch (e) { /* leave absent for later sections */ }
  });
  await ok('configWriter refuses a directory target with remedy', () => {
    const configWriter = require('../app/utils/configWriter');
    const dirTarget = path.join(tmpDir, 'config-dir-target');
    try { fs.mkdirSync(dirTarget, { recursive: true }); } catch (e) { /* ignore */ }
    const savedPath = process.env.CONFIG_PATH;
    process.env.CONFIG_PATH = dirTarget;
    try {
      assert.throws(
        () => configWriter.writeConfig({ setup_complete: true }),
        /bind mount|directory/i
      );
    } finally {
      process.env.CONFIG_PATH = savedPath;
      try { fs.rmdirSync(dirTarget); } catch (e) { /* ignore */ }
    }
  });
  await ok('process env still overrides config.json (legacy installs)', () => {
    const cfgPath = process.env.CONFIG_PATH;
    fs.writeFileSync(cfgPath, JSON.stringify({
      setupComplete: true,
      db: { db_host: 'file-host', db_user: 'u', db_name: 'd' },
      jwt: { key: 'x'.repeat(32) }, app: { secret: 'y'.repeat(32) },
    }));
    const savedDbHost = process.env.DB_HOST;
    try {
      delete process.env.DB_HOST;
      config.reload();
      assert.strictEqual(config.db.db_host, 'file-host');
      assert.strictEqual(config.isSetupComplete(), true);
      process.env.DB_HOST = 'env-host';
      config.reload();
      assert.strictEqual(config.db.db_host, 'env-host');
    } finally {
      if (savedDbHost === undefined) delete process.env.DB_HOST;
      else process.env.DB_HOST = savedDbHost;
      try { fs.unlinkSync(cfgPath); } catch (e) { /* absent */ }
      config.reload();
    }
  });

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
  await ok('floating labels rest on boxed input text line', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'vmp-design-system.css'), 'utf8');
    assert.ok(/\.bmd-form-group \.bmd-label-floating\s*\{\s*top:\s*calc\(50% - 5px\);/.test(css), 'resting offset pinned without !important');
    assert.ok(css.includes('.bmd-form-group.is-filled .bmd-label-floating'), 'floated pin beats vendor float on specificity');
  });
  await ok('tick boxes are visible (vendor hides the native input)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'vmp-design-system.css'), 'utf8');
    const rules = css.match(/\.form-check \.form-check-input\s*\{[^}]*\}/g) || [];
    assert.ok(rules.length, 'checkbox rule exists');
    // Several rules target this selector (the main reset plus narrow
    // overrides); the reset is by far the substantial one.
    const last = rules.reduce((a, b) => (b.length > a.length ? b : a), '');
    // material-dashboard ships opacity:0 / z-index:-1 / width:0 / overflow:hidden
    // / pointer-events:none on .form-check-input. Every one has to be undone or
    // the box renders behind its own label and looks like it is missing.
    for (const prop of ['z-index', 'opacity', 'overflow', 'pointer-events', 'position', 'width', 'height']) {
      assert.ok(new RegExp(prop + '\\s*:').test(last), prop + ' is reset');
    }
    assert.ok(/z-index:\s*auto\s*!important/.test(last), 'z-index leaves the -1 pit');
    assert.ok(/opacity:\s*1\s*!important/.test(last), 'opacity forced visible');
    assert.ok(/pointer-events:\s*auto\s*!important/.test(last), 'input is clickable');
    // ...but the Settings radios/swatches are also nested inside a .form-check
    // and must stay hidden, or a raw radio shows up inside the pill.
    assert.ok(/\.vmp-seg \.form-check-input[\s\S]*?opacity:\s*0\s*!important/.test(css), 'seg radios re-hidden');
    assert.ok(/\.vmp-swatches \.form-check-input[\s\S]*?opacity:\s*0\s*!important/.test(css), 'swatch radios re-hidden');
  });
  await ok('flag tables drop the grid wrapper that inflated every row', () => {
    const tbody = fs.readFileSync(path.join(__dirname, '..', 'views', 'TbodyAdminFlags.ejs'), 'utf8');
    assert.ok(!/class="col-md-12"/.test(tbody), 'no .col-md-12 inside table cells');
    const opens = (tbody.match(/<div\b/g) || []).length;
    const closes = (tbody.match(/<\/div>/g) || []).length;
    assert.strictEqual(opens, closes, 'divs balanced: ' + opens + '/' + closes);
    assert.strictEqual((tbody.match(/name="admin_flags"/g) || []).length, 21, 'all 21 flag rows kept');
    assert.ok(tbody.includes('name="admin_flag_manual_entry"'), 'use-group row kept');
    const admin = fs.readFileSync(path.join(__dirname, '..', 'views', 'ManageAdmin.ejs'), 'utf8');
    assert.ok(admin.includes('vmp-flags-table'), 'table opts into the compact rules');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'vmp-design-system.css'), 'utf8');
    assert.ok(/\.vmp-flags-table td\s*\{[^}]*padding:\s*6px 10px/.test(css), 'compact row padding');
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
  await ok('server refresh command inputs default to css_viprefresh', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'PanelSetting.ejs'), 'utf8');
    for (const id of ['servertableRCONCmd_add', 'servertableRCONCmd_update']) {
      assert.ok(new RegExp(`id="${id}"[^>]*value="css_viprefresh"`).test(html), `${id} pre-filled`);
    }
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'PanelSettings.js'), 'utf8');
    assert.ok(js.includes(`rcon_refresh_cmd || 'css_viprefresh'`), 'update prefill falls back to default');
  });
  await ok('rcon refresh proceeds despite silent query probe, fails soft', async () => {
    const { EventEmitter } = require('events');
    const rconPath = require.resolve('rcon');
    const sqPath = require.resolve('sourcequery');
    const modelPath = path.join(__dirname, '..', 'app', 'models', 'panelServerModal.js');
    const saved = {};
    for (const p of [rconPath, sqPath, modelPath]) saved[p] = require.cache[p];
    const setStub = (p, exp) => { require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
    const restore = () => { for (const p of Object.keys(saved)) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; } };
    let sqBehavior = 'ok';
    let rconMode = 'ok';
    let modelDetails = null;
    class FakeQuery {
      open() { if (sqBehavior === 'throw-open') throw new Error('nope'); }
      getInfo(cb) { setImmediate(() => (sqBehavior === 'ok' ? cb(null, { name: 'x' }) : cb(new Error('timeout')))); }
      close() {}
    }
    class FakeRcon extends EventEmitter {
      connect() { setImmediate(() => (rconMode === 'error' ? this.emit('error', new Error('auth fail')) : this.emit('auth'))); }
      send(cmd) { FakeRcon.lastSent = cmd; setImmediate(() => { this.emit('response', 'ok'); this.emit('end'); }); }
      disconnect() {}
    }
    FakeRcon.lastSent = null;
    try {
      setStub(sqPath, function FakeSQ() { return new FakeQuery(); });
      setStub(rconPath, FakeRcon);
      setStub(modelPath, { getPanelServerDetails: async () => modelDetails });
      const util = require('../app/utils/refreshCFGInServer');
      assert.strictEqual(await util.probeServer('h', 1), true);
      sqBehavior = 'timeout';
      assert.strictEqual(await util.probeServer('h', 1), false);
      sqBehavior = 'throw-open';
      assert.strictEqual(await util.probeServer('h', 1), false);
      sqBehavior = 'timeout';
      await util.sendRconCommand('h', 1, 'p', 'fake_rcon css_viprefresh');
      assert.strictEqual(FakeRcon.lastSent, 'fake_rcon css_viprefresh');
      rconMode = 'error';
      await assert.rejects(() => util.sendRconCommand('h', 1, 'p', 'x'), /RCON failed/);
      rconMode = 'ok';
      // Full path, query silent (the reported bug): still refreshes via RCON.
      modelDetails = { server_ip: 'h', server_port: '1', server_rcon_pass: 'p', rcon_refresh_cmd: null };
      assert.strictEqual(await util.refreshAdminsInServer('sv_x'), 1);
      assert.strictEqual(FakeRcon.lastSent, 'css_viprefresh');
      modelDetails = { server_ip: 'h', server_port: '1', server_rcon_pass: null, rcon_refresh_cmd: null };
      assert.strictEqual(await util.refreshAdminsInServer('sv_x'), 0);
      rconMode = 'error';
      modelDetails = { server_ip: 'h', server_port: '1', server_rcon_pass: 'p', rcon_refresh_cmd: null };
      await assert.rejects(() => util.refreshAdminsInServer('sv_x'), /RCON password and port/);
      assert.strictEqual(await util.refreshBestEffort('sv_x'), 0, 'best-effort never rejects');
    } finally {
      restore();
    }
  });
  await ok('steam ids canonicalize to 64-bit', () => {
    const C = require('../app/utils/steamIdConvertor');
    assert.strictEqual(C.toCanonical64('76561198092023766'), '76561198092023766');
    assert.strictEqual(C.toCanonical64('STEAM_1:0:65879019'), '76561198092023766');
    assert.strictEqual(C.toCanonical64('STEAM_0:0:65879019'), '76561198092023766');
    assert.strictEqual(C.toCanonical64('[U:1:131758038]'), '76561198092023766');
    assert.strictEqual(C.toCanonical64('  "76561198092023766"  '), '76561198092023766');
    // Bare numbers are the 32-bit Steam account ID form.
    assert.strictEqual(C.toCanonical64('131758038'), '76561198092023766');
    assert.strictEqual(C.toCanonical64('123'), '76561197960265851');
    // Steam/FiveM hex forms.
    assert.strictEqual(C.toCanonical64('STEAM:110000107DA77D6'), '76561198092023766');
    assert.strictEqual(C.toCanonical64('0x110000107DA77D6'), '76561198092023766');
    assert.strictEqual(C.toCanonical64('STEAM:0:7DA77D6'), '76561198092023766');
    for (const bad of ['', null, undefined, 'abc', 'STEAM_9:9:9', 'STEAM_1:0:abc', 'STEAM:110000107', '99999999999']) {
      assert.throws(() => C.toCanonical64(bad), TypeError);
    }
    assert.deepStrictEqual(C.quotedAuthIdVariants('STEAM_1:0:65879019'), ['"76561198092023766"', '"STEAM_1:0:65879019"']);
  });
  await ok('gifting flag defaults on, env/file can disable', () => {
    const config = require('../app/config');
    const savedEnv = process.env.GIFTING_ENABLED;
    const cfgPath = process.env.CONFIG_PATH;
    const seed = { gifting: { enabled: false } };
    try {
      delete process.env.GIFTING_ENABLED;
      fs.writeFileSync(cfgPath, JSON.stringify(seed));
      config.reload();
      assert.strictEqual(config.gifting.enabled, false);
      process.env.GIFTING_ENABLED = 'true';
      config.reload();
      assert.strictEqual(config.gifting.enabled, true);
      delete process.env.GIFTING_ENABLED;
      fs.writeFileSync(cfgPath, JSON.stringify({ gifting: { enabled: true } }));
      config.reload();
      assert.strictEqual(config.gifting.enabled, true);
    } finally {
      if (savedEnv === undefined) delete process.env.GIFTING_ENABLED;
      else process.env.GIFTING_ENABLED = savedEnv;
      try { fs.unlinkSync(cfgPath); } catch (e) { /* absent */ }
      config.reload();
    }
  });
  await ok('recipient verification refuses when gifting disabled', async () => {    const config = require('../app/config');
    const savedEnv = process.env.GIFTING_ENABLED;
    const { resolveRecipient } = require('../app/controllers/giftRecipient');
    let payload = null;
    const res = { json: (o) => { payload = o; } };
    res.status = () => res;
    process.env.GIFTING_ENABLED = 'false';
    config.reload();
    try {
      await resolveRecipient({ body: { input: '76561198092023766' }, uuid: 't', method: 'POST', originalUrl: '/x' }, res);
      assert.strictEqual(payload.success, false);
      assert.ok(/disabled/i.test(JSON.stringify(payload)));
    } finally {
      if (savedEnv === undefined) delete process.env.GIFTING_ENABLED;
      else process.env.GIFTING_ENABLED = savedEnv;
      config.reload();
    }
  });
  await ok('store shows gift card only when gifting enabled', () => {
    const ejsMod = require('ejs');
    // Hermetic like the other view test: no filename (so ejs never consults
    // its cross-test compile cache) and no partial includes.
    const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'UserDashboard.ejs'), 'utf8')
      .replace(/<%-\s*include\('(?:Header|Footer)\.ejs'\)\s*%>/g, '');
    const locals = {
      panelSetting: { community_name: 'T', color_theme: 'primary', platform_currency: 'INR', community_logo_url: '' },
      currentURL: '/mydashboard', csrfToken: 't', sessionToken: null, adminType: 0,
      sessionSteamId: 'x', adminName: null, steamName: null,
      paypalActive: false, paypalClientID: '', payuActive: false, payuEnv: 'test',
      razorpayActive: false, colSpan: '12', serverArray: [], bundleArray: [],
      userDataListing: [], userData: { displayname: 'T' },
    };
    const render = (giftingActive) => ejsMod.render(src, { ...locals, giftingActive });
    assert.ok(render(true).includes('vmpGiftToggle'), 'gift toggle shown when enabled');
    assert.ok(!render(false).includes('vmpGiftToggle'), 'gift toggle hidden when disabled');
    assert.ok(render(undefined).includes('vmpGiftToggle'), 'gift toggle shown when flag absent (legacy)');
  });
  await ok('every gateway forwards gifting, including owned-server gift buttons', () => {
    // Owned-server cards emit buyType "giftPurchase" directly (no newPurchase
    // upgrade step), so each gateway's guard must accept it or the VIP is
    // silently granted to the buyer instead of the receiver.
    for (const rel of ['public/js/paypalPayment.js', 'public/js/payU.js', 'public/js/razorPay.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      const guard = src.match(/if \(\w+ && \w+\.isGift && \(type === 'newPurchase'[^)]*\)\)/);
      assert.ok(guard, `${rel} has a gifting guard`);
      assert.ok(guard[0].includes("type === 'giftPurchase'"),
        `${rel} guard accepts giftPurchase (got: ${guard[0]})`);
      // The verified receiver must always ride along once gifting is on.
      assert.ok(/\.isGift = true/.test(src), `${rel} sets isGift`);
      assert.ok(/\.recipientSteamId = \w+\.recipientSteamId/.test(src), `${rel} forwards the verified recipient id`);
    }
    // The owned-server view must emit that buy type for each gateway.
    const dash = fs.readFileSync(path.join(__dirname, '..', 'views', 'UserDashboard.ejs'), 'utf8');
    assert.ok(/data-giftrequired="1"/.test(dash), 'owned cards mark gift-only controls');
    assert.ok((dash.match(/data-buytype="giftPurchase"/g) || []).length >= 3,
      'owned card offers a paypal slot + payu + razorpay gift control');
  });
  await ok('gifting is accepted server-side for all three gateways', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'controllers', 'userDashboard.js'), 'utf8');
    assert.ok(/reqBody\.buyType === 'giftPurchase'/.test(src), 'giftPurchase is honoured server-side');
    assert.ok(/is_gift: isGift \? 1 : 0/.test(src), 'sales record the gift flag');
    assert.ok(/recipient_steamid: isGift \? recipientSteamId64 : null/.test(src), 'sales record the recipient');
    // renew must never be reachable as a gift, and self-gifting must be refused.
    assert.ok(/renewPurchase'\) return reject\("Gifts cannot renew/.test(src), 'gift renew refused');
    assert.ok(/Recipient matches buyer/.test(src), 'self-gift refused');
  });
  await ok('store only offers gateways the admin actually configured', () => {
    const ejsMod = require('ejs');
    const source = fs.readFileSync(path.join(__dirname, '..', 'views', 'UserDashboard.ejs'), 'utf8')
      .replace(/<%-\s*include\('(?:Header|Footer)\.ejs'\)\s*%>/g, '');
    const locals = (cur, payu, rzp, pp, cardCur = 'INR') => ({
      panelSetting: { community_name: 'T', color_theme: 'primary', platform_currency: cur, community_logo_url: '' },
      currentURL: '/mydashboard', csrfToken: 'x', sessionToken: null, adminType: 0,
      sessionSteamId: '76561198092023766', adminName: null, steamName: 'Me',
      userData: { steamId: '76561198092023766', displayname: 'Me', realName: '', avatarUrl: '' },
      // owned server: exercises the gift-only card
      serverArray: [{ tbl_name: 'sv_t', server_name: 'Mine', vip_price: 30, vip_currency: cardCur, vip_days: 30, vmpOwned: true }],
      bundleArray: [], payuEnv: 'test', payuMerchantId: 'x', colSpan: '12',
      paypalActive: pp, paypalClientID: pp ? 'cid' : '', payuActive: payu, razorpayActive: rzp, giftingActive: true,
      userDataListing: [{ servername: 'Mine', data: { authId: '"76561198092023766"', name: 'Me', expireStamp: 1792079631, type: 0 }, serverdata: { tbl_name: 'sv_t', vip_currency: cardCur } }],
    });
    // Count only inside the store card so the membership table's renew buttons
    // (which legitimately have their own controls) don't skew the result.
    const cardSlice = (h) => h.slice(h.indexOf('vmp-product'), h.indexOf('id="serverBundles"'));
    const n = (h, g) => (cardSlice(h).match(new RegExp(`data-gateway="${g}"`, 'g')) || []).length;
    const slots = (h) => (cardSlice(h).match(/vmp-paypal-slot/g) || []).length;

    // Razorpay not configured -> must not appear (the reported bug).
    let h = ejsMod.render(source, locals('INR', true, false, false));
    assert.strictEqual(n(h, 'payu'), 1, 'payu shown when configured');
    assert.strictEqual(n(h, 'razorpay'), 0, 'razorpay hidden when not configured');
    assert.strictEqual(slots(h), 0, 'no empty paypal slot when paypal is off');

    h = ejsMod.render(source, locals('INR', false, true, false));
    assert.strictEqual(n(h, 'razorpay'), 1, 'razorpay shown when configured');
    assert.strictEqual(n(h, 'payu'), 0, 'payu hidden when not configured');

    // INR-only gateways key off the card's own currency, not the panel's:
    // an INR-priced server stays buyable even when the panel default is USD.
    h = ejsMod.render(source, locals('USD', true, true, false));
    assert.strictEqual(n(h, 'payu'), 1, 'payu offered on an INR-priced card');
    assert.strictEqual(n(h, 'razorpay'), 1, 'razorpay offered on an INR-priced card');
    // ...and a USD-priced server is refused by both, whatever the panel says.
    const usdCard = ejsMod.render(source, locals('INR', true, true, false, 'USD'));
    assert.strictEqual(n(usdCard, 'payu'), 0, 'payu hidden on a USD-priced card');
    assert.strictEqual(n(usdCard, 'razorpay'), 0, 'razorpay hidden on a USD-priced card');
    assert.ok(cardSlice(usdCard).includes('No payment method is available'), 'explains why nothing is buyable');

    // Nothing configured at all.
    h = ejsMod.render(source, locals('INR', false, false, false));
    assert.strictEqual(n(h, 'payu') + n(h, 'razorpay'), 0, 'no buttons without config');
    assert.ok(cardSlice(h).includes('No payment method is available'), 'no-method message shown');
  });
  await ok('product card body does not stretch and open a dead gap', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'vmp-design-system.css'), 'utf8');
    // Bootstrap's .card-body is `flex: 1 1 auto`, which absorbs the card's slack
    // and opens a gap under the last child. Pin it and let margin-top:auto
    // bottom-align the footer instead.
    assert.ok(/\.vmp-product \.card-body \{ flex: 0 0 auto; \}/.test(css), 'body pinned to content');
    assert.ok(/\.vmp-product \.card-footer \{ margin-top: auto;/.test(css), 'footer still bottom-aligned');
    const hdr = fs.readFileSync(path.join(__dirname, '..', 'views', 'Header.ejs'), 'utf8');
    const v = (hdr.match(/vmp-design-system\.css\?v=(\d+)/) || [])[1];
    assert.ok(v && Number(v) >= 20, `css cache-buster bumped (v=${v})`);
  });
  await ok('razorpay signature is HMAC(order_id|payment_id) - order first', () => {
    const crypto = require('crypto');
    const pv = require('../app/modules/paymentVerify');
    const cfg = { enabled: true, environment: 'test', keyId: 'k', keySecret: 'sec' };
    // Razorpay documents: hmac_sha256(order_id + "|" + razorpay_payment_id, secret).
    // Reversing the two silently rejects every genuine payment, so pin the order
    // by recomputing the documented signature and requiring it to be accepted.
    const orderId = 'order_1', payId = 'pay_1';
    const documented = crypto.createHmac('sha256', 'sec').update(`${orderId}|${payId}`).digest('hex');
    const reversed = crypto.createHmac('sha256', 'sec').update(`${payId}|${orderId}`).digest('hex');
    assert.notStrictEqual(documented, reversed, 'the two orders really do differ');
    // The signature is checked before any network call, so an accepted signature
    // must produce a *different* error (the fetch) than a rejected one.
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'modules', 'paymentVerify.js'), 'utf8');
    assert.ok(/update\(`\$\{orderId\}\|\$\{paymentId\}`\)/.test(src), 'order_id comes first in the HMAC input');
    assert.ok(!/update\(`\$\{paymentId\}\|\$\{orderId\}`\)/.test(src), 'the reversed form is gone');
    assert.ok(/Razorpay payment signature does not match/.test(src), 'mismatch has a clear message');
    // apiBase override keeps the verify path testable without a live account.
    assert.strictEqual(pv.razorpayBase('test', { apiBase: 'http://127.0.0.1:1234/v1/' }), 'http://127.0.0.1:1234/v1');
    assert.strictEqual(pv.razorpayBase('test', {}), 'https://api.razorpay.com/v1');
    assert.strictEqual(pv.paypalBase('live', { apiBase: 'http://x/' }), 'http://x');
    assert.strictEqual(pv.paypalBase('live', {}), 'https://api-m.paypal.com');
    assert.strictEqual(pv.paypalBase('test', {}), 'https://api-m.sandbox.paypal.com');
    assert.ok(typeof documented === 'string' && pv.razorpayBase);
  });
  await ok('payu verify_payment API is required by default but can be waived', async () => {
    const pv = require('../app/modules/paymentVerify');
    const cfgBase = { enabled: true, environment: 'test', merchantKey: 'K', merchantSalt: 'S' };
    const realish = {
      txnid: 'T1', status: 'SUCCESS',
      udf1: '', udf2: '', udf3: '', udf4: '', udf5: '76561198092023766',
      email: 'a@e.com', firstname: 'A', productinfo: 'p', amount: '30.00',
    };
    const withHash = { ...realish, hash: pv.payuReverseHash(cfgBase, realish) };

    // Default (API on): the reverse hash alone is not enough.
    const strict = await pv.verifyPayment({
      gateway: 'payu', reqBody: { payuData: withHash },
      expected: { amount: 30, currency: 'INR' }, cfg: { payU: cfgBase },
    });
    assert.strictEqual(strict.ok, false, 'with the API enabled the txnid is still confirmed remotely');

    // Waived: the reverse hash alone is accepted, and the amount is bound to ours.
    const waived = await pv.verifyPayment({
      gateway: 'payu', reqBody: { payuData: withHash },
      expected: { amount: 30, currency: 'INR' }, cfg: { payU: { ...cfgBase, verifyApi: false } },
    });
    assert.strictEqual(waived.ok, true, 'reverse-hash-only proof is accepted when verifyApi is off');
    assert.strictEqual(waived.orderId, 'T1');

    // Waived still refuses a wrong amount and a bad hash - the waiver only drops
    // the remote confirmation, it does not disable verification.
    const wrongAmount = await pv.verifyPayment({
      gateway: 'payu', reqBody: { payuData: withHash },
      expected: { amount: 999, currency: 'INR' }, cfg: { payU: { ...cfgBase, verifyApi: false } },
    });
    assert.strictEqual(wrongAmount.ok, false, 'amount still bound with the API waived');
    const badHash = await pv.verifyPayment({
      gateway: 'payu', reqBody: { payuData: { ...realish, hash: 'f'.repeat(128) } },
      expected: { amount: 30, currency: 'INR' }, cfg: { payU: { ...cfgBase, verifyApi: false } },
    });
    assert.strictEqual(badHash.ok, false, 'hash still required with the API waived');
    const notSuccess = await pv.verifyPayment({
      gateway: 'payu', reqBody: { payuData: { ...realish, status: 'FAILED', hash: pv.payuReverseHash(cfgBase, { ...realish, status: 'FAILED' }) } },
      expected: { amount: 30, currency: 'INR' }, cfg: { payU: { ...cfgBase, verifyApi: false } },
    });
    assert.strictEqual(notSuccess.ok, false, 'a hashed FAILED status is still refused');

    // Config plumbing, both the initial load and reload().
    const cfgSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'config', 'index.js'), 'utf8');
    const hits = (cfgSrc.match(/verifyApi: envBool\(process\.env\.PAYU_VERIFY_API/g) || []).length;
    assert.strictEqual(hits, 2, 'PAYU_VERIFY_API is read on both the initial load and reload()');
    const ex = fs.readFileSync(path.join(__dirname, '..', 'app', 'config', 'example_config.json'), 'utf8');
    assert.ok(/"merchantSalt"/.test(ex), 'example config still documents payU');
  });
  await ok('payu hashes match the documented PayU formulas', () => {
    const crypto = require('crypto');
    const pv = require('../app/modules/paymentVerify');
    const cfg = { merchantKey: 'EnoEUc', merchantSalt: 'SALT123' };
    const sha512 = (t) => crypto.createHash('sha512').update(t).digest('hex');

    // Reverse hash, exactly as docs.payu.in documents it:
    //   sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
    const r = { status: 'SUCCESS', udf1: '', udf2: '', udf3: '', udf4: '', udf5: '76561198092023766', email: 'a@e.com', firstname: 'A', productinfo: '30 days VIP', amount: '30.00', txnid: 'TXN1' };
    const literal = 'SALT123|SUCCESS||||||76561198092023766|||||a@e.com|A|30 days VIP|30.00|TXN1|EnoEUc';
    assert.strictEqual(pv.payuReverseHash(cfg, r), sha512(literal), 'reverse hash matches the documented field order');
    // 6 pipes after status, and udf5..udf1 present - the old implementation had
    // 5 pipes and a single udf, so it rejected every genuine PayU response.
    assert.ok(literal.indexOf('SUCCESS||||||') > 0, 'six separators after status, per the docs');
    assert.ok(literal.indexOf('|udf') === -1, 'literal form carries the udf values inline');

    // General command API: sha512(key|command|var1|salt)
    assert.strictEqual(pv.payuCommandHash(cfg, 'verify_payment', 'TXN1'), sha512('EnoEUc|verify_payment|TXN1|SALT123'));
    // Endpoints per environment, from the Verify Payment API reference.
    assert.ok(pv.payuPostservice('test').startsWith('https://test.payu.in/'), 'test endpoint');
    assert.ok(pv.payuPostservice('live').startsWith('https://info.payu.in/'), 'live endpoint');
    assert.ok(pv.payuPostservice('live').includes('form=2'), 'form=2 for JSON responses');
  });
  await ok('amount comparison tolerates major/minor unit reporting', () => {
    const { amountMatches } = require('../app/modules/paymentVerify');
    // Gateways report "30", "30.00" or 3000 (minor units) for the same 30 INR.
    assert.ok(amountMatches(30, 30, 'INR'));
    assert.ok(amountMatches('30.00', 30, 'INR'));
    assert.ok(amountMatches(3000, 30, 'INR'));
    assert.ok(amountMatches('3000', 30, 'INR'));
    assert.ok(!amountMatches(31, 30, 'INR'), 'a different amount is rejected');
    assert.ok(!amountMatches(29.99, 30, 'INR'));
    assert.ok(!amountMatches('abc', 30, 'INR'));
    // Zero-decimal currency: 99 JPY is 99, not 9900.
    assert.ok(amountMatches(99, 99, 'JPY'));
    assert.ok(!amountMatches(9900, 99, 'JPY'));
  });
  await ok('canVerify requires the credentials verification actually needs', () => {
    const pv = require('../app/modules/paymentVerify');
    assert.strictEqual(pv.canVerify('razorpay', { razorPay: { enabled: true, keyId: 'k', keySecret: 's' } }), true);
    assert.strictEqual(pv.canVerify('razorpay', { razorPay: { enabled: true, keyId: 'k', keySecret: '' } }), false, 'key secret required');
    assert.strictEqual(pv.canVerify('razorpay', { razorPay: { enabled: false, keyId: 'k', keySecret: 's' } }), false, 'disabled');
    assert.strictEqual(pv.canVerify('payu', { payU: { enabled: true, merchantKey: 'k', merchantSalt: 's' } }), true);
    assert.strictEqual(pv.canVerify('payu', { payU: { enabled: true, merchantKey: 'k', merchantSalt: '' } }), false, 'salt required');
    // PayPal needs a client SECRET, not just the id used by the browser SDK.
    assert.strictEqual(pv.canVerify('paypal', { paypal: { paypal_client_id: 'id', paypal_client_secret: 'sec' } }), true);
    assert.strictEqual(pv.canVerify('paypal', { paypal: { paypal_client_id: 'id', paypal_client_secret: '' } }), false,
      'a client id alone cannot verify payments');
    assert.strictEqual(pv.canVerify('stripe', {}), false, 'unknown gateway is never verifiable');
  });
  await ok('forged payments are rejected before any VIP is granted', async () => {
    const pv = require('../app/modules/paymentVerify');
    const payuCfg = { payU: { enabled: true, environment: 'test', merchantKey: 'K', merchantSalt: 'S' } };
    const rzCfg = { razorPay: { enabled: true, environment: 'test', keyId: 'rk', keySecret: 'rs' } };
    const ppCfg = { paypal: { paypal_client_id: 'id', paypal_client_secret: 'sec', environment: 'test' } };
    const expected = { amount: 30, currency: 'INR' };

    // A hand-crafted "SUCCESS" with no gateway evidence at all.
    let r = await pv.verifyPayment({ gateway: 'payu', reqBody: { payuData: { txnid: 'X', status: 'SUCCESS' } }, expected, cfg: payuCfg });
    assert.strictEqual(r.ok, false, 'payu: missing reverse hash rejected');
    // Wrong hash.
    r = await pv.verifyPayment({
      gateway: 'payu',
      reqBody: { payuData: { txnid: 'X', status: 'SUCCESS', hash: 'deadbeef', udf5: '', email: '', firstname: '', productinfo: '', amount: '30.00' } },
      expected, cfg: payuCfg,
    });
    assert.strictEqual(r.ok, false, 'payu: wrong reverse hash rejected');
    // Correctly hashed but not SUCCESS.
    const good = { txnid: 'X', status: 'FAILED', udf1: '', udf2: '', udf3: '', udf4: '', udf5: '', email: 'a@e.com', firstname: 'A', productinfo: 'p', amount: '30.00' };
    r = await pv.verifyPayment({ gateway: 'payu', reqBody: { payuData: { ...good, hash: pv.payuReverseHash(payuCfg.payU, good) } }, expected, cfg: payuCfg });
    assert.strictEqual(r.ok, false, 'payu: a hashed FAILED status is still rejected');

    // Razorpay: no signature, then a wrong signature. Both must fail before the
    // network call, so this test never touches Razorpay.
    r = await pv.verifyPayment({ gateway: 'razorpay', reqBody: { razorpayData: { razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_1' } }, expected, cfg: rzCfg });
    assert.strictEqual(r.ok, false, 'razorpay: missing signature rejected');
    r = await pv.verifyPayment({ gateway: 'razorpay', reqBody: { razorpayData: { razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_1', razorpay_payment_signature: 'nope' } }, expected, cfg: rzCfg });
    assert.strictEqual(r.ok, false, 'razorpay: wrong signature rejected');

    // PayPal without a secret must refuse rather than trust the browser.
    r = await pv.verifyPayment({ gateway: 'paypal', reqBody: { paymentData: { id: 'ORDER1', status: 'COMPLETED' } }, expected, cfg: { paypal: { paypal_client_id: 'id', paypal_client_secret: '' } } });
    assert.strictEqual(r.ok, false, 'paypal: no client secret means no verification, so refuse');
    assert.ok(/client secret/i.test(r.reason), 'and say why');

    // Unconfigured gateway entirely.
    r = await pv.verifyPayment({ gateway: 'payu', reqBody: {}, expected, cfg: { payU: { enabled: true, merchantKey: '', merchantSalt: '' } } });
    assert.strictEqual(r.ok, false, 'unconfigured payu refused');
    // Unknown gateway.
    r = await pv.verifyPayment({ gateway: 'stripe', reqBody: {}, expected, cfg: {} });
    assert.strictEqual(r.ok, false, 'unknown gateway refused');
    // A bad expected amount must not slip through.
    r = await pv.verifyPayment({ gateway: 'payu', reqBody: {}, expected: { amount: 'x', currency: 'INR' }, cfg: payuCfg });
    assert.strictEqual(r.ok, false, 'unresolvable expected amount refused');
    // A forged client status must never be enough on its own.
    r = await pv.verifyPayment({ gateway: 'payu', reqBody: { paymentData: { status: 'SUCCESS', order_id: 'made-up' } }, expected, cfg: payuCfg });
    assert.strictEqual(r.ok, false, 'a browser-asserted SUCCESS alone is not a payment');
  });
  await ok('settlement verifies with the gateway and fails closed', () => {
    const ud = fs.readFileSync(path.join(__dirname, '..', 'app', 'controllers', 'userDashboard.js'), 'utf8');
    // The verification must gate the grant, and run before the VIP insert.
    assert.ok(/verifyPayment\(\{ gateway: reqBody\.gateway, reqBody, expected \}\)/.test(ud), 'verification is called');
    const vIdx = ud.indexOf('await verifyPayment(');
    const insertIdx = ud.indexOf('await vipModel.insertVIPData');
    assert.ok(vIdx > 0 && insertIdx > 0 && vIdx < insertIdx, 'verification happens before the VIP row is written');
    assert.ok(/if \(!verdict\.ok\)/.test(ud), 'a failed verdict rejects');
    // The hand-rolled hash blocks that were wrong must be gone.
    assert.ok(!/reverseKeyArray/.test(ud), 'the incorrect PayU reverse-hash block is gone');
    assert.ok(!/rzp\.razorpay_signature \|\|/.test(ud), 'the incorrect Razorpay signature check is gone');
    // Config toggle defaults to on.
    const cfgSrc = fs.readFileSync(path.join(__dirname, '..', 'app', 'config', 'index.js'), 'utf8');
    assert.ok(/verify_payments = envBool\(process\.env\.VERIFY_PAYMENTS, \(\w+\.verify_payments !== false\)\)/.test(cfgSrc),
      'verification defaults to enabled (fail closed)');
  });
  await ok('store hides gateways that cannot be verified', async () => {
    const dbBridge = require('../app/db/db_bridge');
    const origQuery = dbBridge.query;
    dbBridge.query = async (sql) => {
      const q = String(sql).replace(/\s+/g, ' ');
      if (/COUNT\(authId\)/i.test(q)) return { usercount: '0' };
      if (/FROM `?tbl_servers`?/i.test(q)) return [{ tbl_name: 'sv_t', server_name: 'Mine', server_ip: '', server_port: '', vip_slots: 10, vip_price: 30, vip_currency: 'INR', vip_days: 30 }];
      if (/FROM `?sv_t`?\b/i.test(q)) return [];
      return [];
    };
    const config = require('../app/config');
    const saved = JSON.parse(JSON.stringify(config.payment_gateways));
    const savedVerify = config.verify_payments;
    try {
      const { myDashboardFunc } = require('../app/controllers/userDashboard');
      // Razorpay enabled but with no key secret -> must not be offered.
      Object.assign(config.payment_gateways, {
        payU: { enabled: true, environment: 'test', merchantKey: 'k', merchantSalt: 's' },
        razorPay: { enabled: true, environment: 'test', keyId: 'k', keySecret: '' },
        paypal: { paypal_client_id: 'cid', paypal_client_secret: '' },
      });
      config.verify_payments = true;
      let r = await myDashboardFunc({}, { id: '76561198092023766', displayName: 'Me' });
      assert.strictEqual(r.razorpayActive, false, 'razorpay hidden without a key secret');
      assert.strictEqual(r.paypalActive, false, 'paypal hidden without a client secret');
      assert.strictEqual(r.payuActive, true, 'payu shown: it is fully configured');

      // With credentials present they come back.
      config.payment_gateways.razorPay.keySecret = 'rs';
      config.payment_gateways.paypal.paypal_client_secret = 'sec';
      r = await myDashboardFunc({}, { id: '76561198092023766', displayName: 'Me' });
      assert.strictEqual(r.razorpayActive, true, 'razorpay shown once verifiable');
      assert.strictEqual(r.paypalActive, true, 'paypal shown once verifiable');
    } finally {
      Object.assign(config.payment_gateways, saved);
      config.verify_payments = savedVerify;
      dbBridge.query = origQuery;
    }
  });
  await ok('payment scripts are cache-busted', () => {
    // These carry gateway + currency logic; an unversioned <script> lets a
    // browser keep serving a stale copy and silently mask the fix.
    const dash = fs.readFileSync(path.join(__dirname, '..', 'views', 'UserDashboard.ejs'), 'utf8');
    for (const f of ['paypalPayment.js', 'payU.js', 'razorPay.js']) {
      const m = dash.match(new RegExp(`src="\\./js/${f.replace('.', '\\.')}(\\?v=\\d+)?"`));
      assert.ok(m, `${f} is included`);
      assert.ok(m[1], `${f} has a cache-busting version`);
    }
    const css = (fs.readFileSync(path.join(__dirname, '..', 'views', 'Header.ejs'), 'utf8').match(/vmp-design-system\.css\?v=(\d+)/) || [])[1];
    assert.ok(css && Number(css) >= 20, `design-system css version bumped (v=${css})`);
  });
  await ok('per-server currency: row wins, panel setting is only the default', async () => {
    const { currencyForRow, resolveRowCurrency, normalizeCurrency, gatewaySupportsCurrency, unsupportedCurrencyMessage, isInrOnlyGateway, SUPPORTED_CURRENCIES } = require('../app/utils/currency');
    assert.strictEqual(currencyForRow({ vip_currency: 'USD' }, 'INR'), 'USD', 'row currency is authoritative');
    assert.strictEqual(currencyForRow({}, 'INR'), 'INR', 'panel setting fills a missing row value');
    assert.strictEqual(currencyForRow({ vip_currency: '???' }, 'INR'), 'INR', 'junk row value falls back');
    assert.strictEqual(currencyForRow({ vip_currency: '  ' }, 'INR'), 'INR', 'blank row value falls back');
    assert.strictEqual(await resolveRowCurrency({ vip_currency: 'USD' }, 'INR'), 'USD');
    assert.strictEqual(normalizeCurrency(' inr '), 'INR');
    assert.strictEqual(normalizeCurrency('INRXX'), null);
    // PayU India settles INR only. Razorpay is NOT INR-only: it supports 160+
    // currencies on Checkout via International Payments, so it must accept the
    // row's own currency. Treating it as INR-only was outdated and needlessly
    // blocked multi-currency sellers.
    assert.ok(isInrOnlyGateway('payu') && isInrOnlyGateway('PAYU'));
    assert.ok(!isInrOnlyGateway('razorpay'), 'razorpay is not INR-only');
    assert.ok(!isInrOnlyGateway('paypal'));

    assert.strictEqual(gatewaySupportsCurrency('payu', 'INR'), true);
    assert.strictEqual(gatewaySupportsCurrency('payu', 'USD'), false);
    assert.strictEqual(gatewaySupportsCurrency('razorpay', 'INR'), true);
    assert.strictEqual(gatewaySupportsCurrency('razorpay', 'USD'), true, 'razorpay accepts USD per its international payments docs');
    assert.strictEqual(gatewaySupportsCurrency('paypal', 'USD'), true);
    assert.strictEqual(gatewaySupportsCurrency('paypal', 'INR'), true);
    assert.strictEqual(gatewaySupportsCurrency('paypal', 'JPY'), false, 'unsupported currency refused');
    assert.ok(/only charge in INR/.test(unsupportedCurrencyMessage('payu', 'USD')));
    assert.ok(/PayU/.test(unsupportedCurrencyMessage('payu', 'USD')));
  });
  await ok('minor-unit conversion respects the currency exponent', () => {
    const { minorUnitExponent, toMinorUnits, fromMinorUnits, formatAmount } = require('../app/utils/currency');
    assert.strictEqual(minorUnitExponent('INR'), 2);
    assert.strictEqual(minorUnitExponent('USD'), 2);
    assert.strictEqual(minorUnitExponent('JPY'), 0, 'zero-decimal currency');
    assert.strictEqual(minorUnitExponent('KWD'), 3, 'three-decimal currency');
    assert.strictEqual(minorUnitExponent('ZZZ'), 2, 'unknown defaults to 2');
    assert.strictEqual(toMinorUnits(30, 'INR'), 3000);
    assert.strictEqual(toMinorUnits(30, 'JPY'), 30, 'JPY 30 yen, not 3000');
    assert.strictEqual(toMinorUnits(99.999, 'KWD'), 99999);
    assert.strictEqual(fromMinorUnits(3000, 'INR'), 30);
    assert.strictEqual(fromMinorUnits(30, 'JPY'), 30);
    assert.strictEqual(formatAmount(30, 'INR'), '30.00', 'PayU hashes a fixed 2-decimal string');
    assert.strictEqual(formatAmount(30, 'JPY'), '30');
    assert.throws(() => toMinorUnits('abc', 'INR'), TypeError);
    // A hardcoded *100 is the bug this replaces.
    assert.notStrictEqual(toMinorUnits(30, 'JPY'), 30 * 100);
  });
  await ok('per-server currency: admin can set it, and it actually saves', () => {
    const set = fs.readFileSync(path.join(__dirname, '..', 'views', 'PanelSetting.ejs'), 'utf8');
    // Three distinct, enabled selects. They used to share one disabled input
    // with id "servertablecurrency", so the update path always read the add
    // form's value and every server inherited the panel currency.
    for (const id of ['serverCurrency_add', 'serverCurrency_update', 'bundle_currency_add']) {
      assert.ok(set.includes(`id="${id}"`), `${id} exists`);
      const i = set.indexOf(`id="${id}"`);
      const start = set.lastIndexOf('<select', i);
      assert.ok(start >= 0 && set.slice(start, i).includes('name="servertablecurrency"'), `${id} is a named select`);
      assert.ok(!/<select[^>]*id="${id}"[^>]*disabled/.test(set.slice(start, set.indexOf('>', i))), `${id} is editable`);
    }
    assert.ok(!/id="servertablecurrency"/.test(set), 'ambiguous duplicate id removed');
    assert.ok(/Razorpay and PayU can only charge INR/.test(set), 'admin is told about the INR-only limit');

    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'PanelSettings.js'), 'utf8');
    assert.ok(/\$\('#serverCurrency_add'\)/.test(js), 'add reads its own field');
    assert.ok(/\$\('#serverCurrency_update'\)/.test(js), 'update reads its own field');
    assert.ok(!/\$\('#servertablecurrency'\)/.test(js), 'no ambiguous selector left');
    // The update form must be repopulated from the row, or saving any other
    // field would silently reset the currency.
    assert.ok(/\$\('#serverCurrency_update'\)\.val\(cur\)/.test(js), 'update form repopulated from the row');
    // All three selects must fall back to the panel default, so a save that
    // happens before/without a row value cannot invent a currency.
    for (const id of ['serverCurrency_add', 'serverCurrency_update', 'bundle_currency_add']) {
      const i = set.indexOf(`id="${id}"`);
      const start = set.lastIndexOf('<select', i);
      const sel = set.slice(start, set.indexOf('</select>', i));
      assert.ok(/platform_currency\)\.toUpperCase\(\)===c\?'selected':''/.test(sel),
        `${id} marks the panel currency as the default`);
      assert.ok(/value="<%=c%>"/.test(sel), `${id} offers both currencies`);
    }
    assert.ok(/vmpResetCurrencyDefault\('#serverCurrency_add'\)/.test(js), 'reset restores the panel default');
    assert.ok(/vmpResetCurrencyDefault\('#bundle_currency_add'\)/.test(js), 'bundle reset restores the default');

    // The model already persists it; keep it that way.
    const model = fs.readFileSync(path.join(__dirname, '..', 'app', 'models', 'panelServerModal.js'), 'utf8');
    assert.ok((model.match(/vip_currency/g) || []).length >= 3, 'insert and update both write vip_currency');
  });
  await ok('server/bundle currency is validated server-side', async () => {
    const { addPanelServerFunc } = require('../app/controllers/panelServers.js');
    const userModel = require('../app/models/userModel.js');
    const origGet = userModel.getUserDataByUsername;
    userModel.getUserDataByUsername = async () => ({ sec_key: 'k' });
    const base = { tablename: 'sv_x:sv_x', servername: 'S', secKey: 'k', submit: 'insert' };
    try {
      for (const bad of ['EUROS', 'INRXX', '12', '<script>']) {
        await assert.rejects(() => addPanelServerFunc({ ...base, servervipcurrency: bad }, 'owner'),
          /currency must be one of/i, `rejects ${bad}`);
      }
      // A valid currency is accepted and normalised.
      const panelServerModal = require('../app/models/panelServerModal.js');
      const origIns = panelServerModal.insertNewPanelServer;
      let seen = null;
      panelServerModal.insertNewPanelServer = async (o) => { seen = o.servervipcurrency; return { ok: 1 }; };
      try {
        const r = await addPanelServerFunc({ ...base, servervipcurrency: 'inr' }, 'owner');
        assert.ok(r, 'accepted a valid currency');
        assert.strictEqual(seen, 'INR', 'normalised to uppercase');
      } finally { panelServerModal.insertNewPanelServer = origIns; }
    } finally { userModel.getUserDataByUsername = origGet; }
  });
  await ok('INR-only gateways refuse a foreign-currency server server-side', async () => {
    // The storefront gate is cosmetic; these controllers are the real guard.
    const { initPayUPaymentFunc } = require('../app/controllers/payU.js');
    const req = { protocol: 'https', get: () => 'vip.example.com' };
    const mk = (cur) => ({ serverData: { tbl_name: 'sv_t', server_name: 'S', vip_price: 30, vip_currency: cur, vip_days: 30 }, type: 'newPurchase', userFirstName: 'A', userEmail: 'a@e.com', userMobile: '1' });
    const row = (cur) => Object.assign({}, INR_ROW, { vip_price: 30, vip_currency: cur });
    await withServerRow(row('USD'), async () => {
      await assert.rejects(() => initPayUPaymentFunc(mk('USD'), { id: '76561198092023766' }, 'k', req), /only charge in INR/);
    });
    const ok = await withServerRow(row('INR'), () => initPayUPaymentFunc(mk('INR'), { id: '76561198092023766' }, 'k', req));
    assert.strictEqual(ok.amount, '30.00', 'INR server still transacts, amount fixed to 2 decimals');

    const rz = require('../app/controllers/razorPay.js');
    const call = (body) => new Promise((resolve) => {
      rz.initRazorpayPayment({ body, user: { id: '76561198092023766' } }, { json: resolve }).catch((e) => resolve({ success: false, data: { error: String(e) } }));
    });
    const usd = await call(mk('USD'));
    assert.notStrictEqual(usd.success, true, 'razorpay refuses a USD server');

    // And settlement re-checks, so a crafted request cannot route around the UI.
    const ud = fs.readFileSync(path.join(__dirname, '..', 'app', 'controllers', 'userDashboard.js'), 'utf8');
    assert.ok(/gatewaySupportsCurrency\(reqBody\.gateway, srv\.vip_currency\)/.test(ud), 'settlement re-checks gateway vs currency');
  });
  await ok('store quotes each card in its own currency and gates per card', () => {
    const ejsMod = require('ejs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'UserDashboard.ejs'), 'utf8')
      .replace(/<%-\s*include\('(?:Header|Footer)\.ejs'\)\s*%>/g, '');
    const card = (tbl, name, cur) => ({ tbl_name: tbl, server_name: name, server_ip: '1.2.3.4', server_port: 27015, vip_price: 30, vip_currency: cur, vip_days: 30 });
    const row = (tbl, name, cur) => ({ servername: name, data: { authId: '"76561198092023766"', name: 'K', expireStamp: 1792079631, type: 0 }, serverdata: { tbl_name: tbl, vip_currency: cur } });
    const h = ejsMod.render(src, {
      panelSetting: { community_name: 'V', color_theme: 'primary', platform_currency: 'INR', community_logo_url: '' },
      currentURL: '/mydashboard', csrfToken: 'x', sessionToken: null, adminType: 0,
      sessionSteamId: '76561198092023766', adminName: null, steamName: 'K',
      userData: { steamId: '76561198092023766', displayname: 'K', realName: '', avatarUrl: '' },
      userDataListing: [row('sv_inr', 'INR Server', 'INR'), row('sv_usd', 'USD Server', 'USD')],
      serverArray: [card('sv_inr', 'INR Server', 'INR'), card('sv_usd', 'USD Server', 'USD')],
      bundleArray: [], payuEnv: 'test', payuMerchantId: 'x', colSpan: '12',
      paypalActive: true, paypalClientID: 'cid', payuActive: true, razorpayActive: true, giftingActive: true,
    });
    assert.ok(h.includes('>30 INR<'), 'INR card quotes INR');
    assert.ok(h.includes('>30 USD<'), 'USD card quotes USD');
    // Slice each card region: from a card marker to the next card marker or the
    // bundles tab, whichever comes first. Without the upper bound the last
    // card's slice runs on into the renew table and picks up its buttons.
    const MARK = 'class="card vmp-product"';
    const marks = [...h.matchAll(new RegExp(MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map((m) => m.index);
    const region = (i) => {
      const from = marks[i];
      const nextCard = marks[i + 1] === undefined ? h.length : marks[i + 1];
      const bundles = h.indexOf('id="serverBundles"');
      const stop = bundles > from && bundles < nextCard ? bundles : nextCard;
      return h.slice(from, stop);
    };
    const n = (s, g) => (s.match(new RegExp(`data-gateway="${g}"`, 'g')) || []).length;
    const inr = region(0), usd = region(1);
    assert.strictEqual(n(inr, 'payu'), 1, 'INR card offers PayU');
    assert.strictEqual(n(inr, 'razorpay'), 1, 'INR card offers Razorpay');
    assert.strictEqual(n(usd, 'payu'), 0, 'USD card hides PayU');
    assert.strictEqual(n(usd, 'razorpay'), 0, 'USD card hides Razorpay');
    assert.ok((usd.match(/vmp-paypal-slot/g) || []).length >= 1, 'USD card still buyable via PayPal');
    // India-only SDKs load because at least one card is INR-priced.
    assert.ok(/bolt\.min\.js/.test(h) && /checkout\.razorpay\.com/.test(h), 'INR SDKs still loaded');
  });
  await ok('settlement never trusts the client for price, flag or server count', () => {
    const ud = fs.readFileSync(path.join(__dirname, '..', 'app', 'controllers', 'userDashboard.js'), 'utf8');
    // vip_flag is the SourceMod admin/immunity assignment. It used to be read
    // straight off the request, so any buyer could grant themselves an admin
    // group for the purchased period.
    assert.ok(!/const flag = reqBody\.serverData\.vip_flag/.test(ud), 'vip_flag is not taken from the request');
    assert.ok(/flag = srv\.vip_flag/.test(ud), 'vip_flag comes from our own row');
    assert.ok(/flag = chosen\.bundle_flags/.test(ud), 'bundle flag comes from our own row');
    // A non-bundle purchase must cover exactly one server, else a crafted
    // "sv_a,sv_b" buys two for one price.
    assert.ok(/if \(tbls\.length > 1\) return reject\("Invalid server selection"\)/.test(ud), 'single-server purchases enforced');
    // The replay key that is CHECKED must be the key that is STORED.
    assert.ok(/reqBody\.verifiedOrderKey = `\$\{reqBody\.gateway\}:\$\{verdict\.orderId\}`/.test(ud), 'composite key built once');
    assert.ok(/orderExists\(reqBody\.verifiedOrderKey\)/.test(ud), 'checked on that key');
    assert.ok(/order_id: reqBody\.verifiedOrderKey \|\| quotedOrderId/.test(ud), 'and the same key is stored');
    assert.ok(!/orderExists\(quotedOrderId\)/.test(ud), 'the bypassable client-id pre-check is gone');
    // Pre-grant validation must precede the sale insert, or a refusal burns the
    // order id and blocks every retry.
    const pre = ud.indexOf('Pre-grant validation');
    const ins = ud.indexOf('insertNewSaleRecord(paymentInsertObj');
    assert.ok(pre > 0 && ins > 0 && pre < ins, 'validation happens before the order is consumed');
    // A plain purchase must not stack a second row for someone who has VIP.
    assert.ok(/use Renew instead/.test(ud), 'duplicate VIP row refused on a plain purchase');
  });
  await ok('settlement never trusts the client for the bundle price', () => {
    const ud = fs.readFileSync(path.join(__dirname, '..', 'app', 'controllers', 'userDashboard.js'), 'utf8');
    // The bundle payload carries no bundle_name key, so the lookup always missed
    // and every bundle payment was captured then refused: money taken, no VIP.
    assert.ok(/\(reqBody\.serverData \|\| \{\}\)\.bundle_name \|\| \(reqBody\.serverData \|\| \{\}\)\.server_name/.test(ud),
      'bundle resolved by bundle_name, falling back to server_name');
    assert.ok(!/reqBody\.serverData\.bundle_price/.test(ud), 'price is not read from the request');
    // Both payload builders must send the key the server looks for.
    for (const rel of ['app/controllers/userDashboard.js', 'public/js/myDashboard.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.ok(/"bundle_name":\s*(bundleList\[i\]|dataArray\[i\])\.bundle_name/.test(src),
        `${rel} sends bundle_name in the payload`);
    }
  });
  await ok('buyer HTML never carries the RCON password', () => {
    const ud = fs.readFileSync(path.join(__dirname, '..', 'app', 'controllers', 'userDashboard.js'), 'utf8');
    // getPanelServersList is SELECT *, so the row carried server_rcon_pass and
    // the renew buttons serialise `serverdata` into the buyer's page.
    assert.ok(/getPanelServersSaleListing\(\)/.test(ud), 'membership enrichment uses the secret-free projection');
    const single = fs.readFileSync(path.join(__dirname, '..', 'app', 'controllers', 'panelServers.js'), 'utf8');
    assert.ok(/rcon_redacted/.test(single), 'the single-server endpoint masks the RCON password');
    assert.ok(/isSuper && hasKey/.test(single), 'only a super admin with the session key sees it');
    const settings = fs.readFileSync(path.join(__dirname, '..', 'app', 'controllers', 'panelSettings.js'), 'utf8');
    assert.ok(/webhook_redacted/.test(settings), 'the Discord webhook is not handed to non-super admins');
    assert.ok(/DISCORD_WEBHOOK_RE/.test(settings), 'webhook URL is validated (no blind SSRF)');
  });
  await ok('admin-only and proxy routes are authenticated', () => {
    const router = fs.readFileSync(path.join(__dirname, '..', 'app', 'routes', 'router.js'), 'utf8');
    // It is an admin tool (loaded by ManageVIP/ManageAdmin) and proxies to Steam.
    const m = router.match(/app\.post\('\/fetchsteamprofiledata'[^)]*\)/);
    assert.ok(m, 'route exists');
    assert.ok(/checkToken/.test(m[0]), 'fetchsteamprofiledata requires auth');
    assert.ok(!/app\.post\('\/fetchsteamprofiledata',\s*fetchProfileData\)/.test(router), 'it is not left open');
  });
  await ok('a broken config.json fails closed instead of reopening the installer', () => {
    const fsx = require('fs');
    const osx = require('os');
    const pathx = require('path');
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'vmp-cfg-'));
    const good = { setupComplete: true, db: { db_host: 'h', db_user: 'u', db_name: 'n' }, jwt: { key: 'x'.repeat(40) }, app: { secret: 'y'.repeat(40) } };
    const writeAndLoad = (contents) => {
      const p = pathx.join(dir, 'config.json');
      if (contents === null) { try { fsx.unlinkSync(p); } catch (e) { /* absent */ } }
      else fsx.writeFileSync(p, contents);
      const cfgPath = pathx.join(dir, 'c.json');
      fsx.writeFileSync(cfgPath, p);
      const cfg = require(pathx.join(__dirname, '..', 'app', 'config', 'index.js'));
      const savedPath = process.env.CONFIG_PATH;
      process.env.CONFIG_PATH = p;
      try { cfg.reload(); } finally { process.env.CONFIG_PATH = savedPath; }
      return cfg;
    };
    const cfg = require(pathx.join(__dirname, '..', 'app', 'config', 'index.js'));
    const savedConfigPath = process.env.CONFIG_PATH;
    // absent -> first boot, wizard allowed, no failure flagged
    writeAndLoad(null);
    assert.strictEqual(cfg.configLoadFailure(), null, 'an absent config is normal first boot');
    // valid -> complete
    writeAndLoad(JSON.stringify(good));
    assert.strictEqual(cfg.configLoadFailure(), null, 'a valid config raises no failure');
    // CORRUPT -> must be flagged, not silently replaced by the example template
    // (whose setupComplete is false, which reopens the unauthenticated wizard).
    writeAndLoad('{ this is not json');
    const err = cfg.configLoadFailure();
    assert.ok(err && /could not be used as JSON/.test(err), 'a corrupt config is reported, not swallowed');
    const srv = fsx.readFileSync(pathx.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(/configLoadFailure/.test(srv), 'the server checks it');
    assert.ok(/res\.status\(503\)/.test(srv), 'and refuses to serve with 503');
    // Restore the REAL config: config.reload() mutates module-level state that
    // the controllers captured at require time, so leaving it pointed at a temp
    // file silently breaks every later test that reads gateway config.
    writeAndLoad(JSON.stringify(good));
    assert.strictEqual(cfg.configLoadFailure(), null);
    if (savedConfigPath) process.env.CONFIG_PATH = savedConfigPath;
    else delete process.env.CONFIG_PATH;
    cfg.reload();
    assert.ok(cfg.payment_gateways && cfg.payment_gateways.payU, 'payment gateway config restored');
  });
  await ok('config precedence and reload stay consistent with the docs', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'config', 'index.js'), 'utf8');
    // dotenv must not push a legacy .env back OVER an env var that is set: the
    // wizard wrote credentials, reloaded, and installed into the .env database.
    assert.ok(!/dotenv'\)\.config\(\{[^}]*override:\s*true/.test(src), 'reload() does not use dotenv override');
    // The documented name is SERVERS_TABLE; reload used to read SERVER_TABLE.
    const tableReads = src.match(/env\.SERVER_?S?_?TABLE/g) || [];
    assert.ok(!/process\.env\.SERVER_TABLE\b/.test(src), 'the undocumented SERVER_TABLE is gone');
    assert.ok(tableReads.length >= 2, 'SERVERS_TABLE is read on both load and reload');
    // reload() must re-apply the top-level file spread, or setupComplete sticks.
    assert.ok(/Object\.assign\(config, fresh\)/.test(src), 'reload re-applies file keys');
    assert.ok(/RESERVED_CONFIG_KEYS/.test(src), 'and keeps its helper functions');
    // SETUP_COMPLETE=false must be able to force the panel back to the wizard.
    assert.ok(/envFlag === 'false' \? false/.test(src), 'SETUP_COMPLETE=false overrides the file');
  });
  await ok('migrations apply one change per statement so they converge', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'app', 'db', 'migrations', '001_indexes_gifting.sql'), 'utf8');
    const executable = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const stmts = executable.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
    for (const s of stmts) {
      const adds = (s.match(/ADD COLUMN/g) || []).length;
      assert.ok(adds <= 1, `at most one ADD COLUMN per statement, got ${adds}: ${s.slice(0, 60)}`);
    }
    // A multi-clause ALTER aborts whole if one column exists, and the runner
    // records the file as applied anyway.
    assert.ok(!/ADD COLUMN[^;]*,\s*\n?\s*ADD COLUMN/.test(executable), 'no multi-clause ADD COLUMN');
  });
  await ok('settings tables are escaped and delete buttons avoid inline handlers', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'PanelSettings.js'), 'utf8');
    // A low-privilege admin could store an <img onerror> as a server/bundle name;
    // the super admin's settings page then executed it in their session.
    assert.ok(/var escHtml = window\.escHtml \|\|/.test(js), 'escHtml available');
    assert.ok(!/onclick="deleteP(Server|Bundle)ajax/.test(js), 'no inline onclick with interpolated data');
    assert.ok(/data-del-server="1"/.test(js) && /data-del-bundle="1"/.test(js), 'delete controls use data attributes');
    assert.ok(/closest\('\[data-del-server\]'\)/.test(js), 'with a delegated listener');
    // The confirm dialog built by those handlers must escape too.
    assert.ok(/<code>\$\{escHtml\(tablename\)\}<\/code>/.test(js), 'confirm dialog escapes the name');
    assert.ok(/<code>\$\{escHtml\(bundlename\)\}<\/code>/.test(js), 'bundle dialog escapes the name');
    // The shared helper must exist and cover the dangerous characters.
    const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'vmp-ui.js'), 'utf8');
    assert.ok(/window\.escHtml = window\.escHtml \|\|/.test(ui), 'shared escHtml defined in vmp-ui.js');
    const shared = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'myDashboard.js'), 'utf8');
    assert.ok(/function escHtml/.test(shared), 'the same escaping is used elsewhere');
  });
  await ok('payment orders are priced from the database, not the request', async () => {
    // The amount is signed with the merchant key, so a client-supplied figure
    // would be an attacker-chosen value authenticated by us.
    for (const rel of ['app/controllers/payU.js', 'app/controllers/razorPay.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.ok(/getPanelServerDetails\(requested\)/.test(src), `${rel} reads the server row`);
      assert.ok(!/vip_price, vip_currency, vip_days \} = reqBody\.serverData/.test(src),
        `${rel} does not destructure price from the request`);
      assert.ok(!/resolveRowCurrency\(reqBody\.serverData\)/.test(src), `${rel} does not take currency from the request`);
    }
    const model = fs.readFileSync(path.join(__dirname, '..', 'app', 'models', 'myDashboardModel.js'), 'utf8');
    assert.ok(/module\.exports\.TABLE_NAME_RE/.test(model), 'the table-name allow-list is exported for validation');
  });
  await ok('a renewal that extends nothing is not reported as success', () => {
    const vip = fs.readFileSync(path.join(__dirname, '..', 'app', 'models', 'vipModel.js'), 'utf8');
    // mysql2 returns a truthy OkPacket for an UPDATE that matched no rows.
    assert.ok(/affectedRows/.test(vip), 'affectedRows is inspected');
    assert.ok(/No VIP row matched this renewal/.test(vip), 'and a no-op renewal is refused');
    // Extend from the later of the stored expiry and now.
    assert.ok(/GREATEST\(expireStamp, UNIX_TIMESTAMP\(\)\)/.test(vip), 'renewal extends from max(expiry, now)');
    const sales = fs.readFileSync(path.join(__dirname, '..', 'app', 'models', 'salesModel.js'), 'utf8');
    assert.ok(!/Payer Surname Missing/.test(sales), 'a missing surname no longer voids a paid order');
    assert.ok(!/Payer Email Missing/.test(sales), 'a missing email no longer voids a paid order');
    assert.ok(/const payerSurname = dataObj\.payer_surname \|\| null/.test(sales), 'descriptive fields are normalised, not required');
  });
  await ok('fix: handlers without a promise cannot reject', () => {
    // `return reject(...)` inside an async express handler threw a ReferenceError
    // instead of denying access, so the buyer saw a ReferenceError.
    for (const rel of ['app/controllers/auditLogs.js', 'app/controllers/salesRecord.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.ok(!/return reject\(/.test(src), `${rel} no longer calls an undefined reject`);
      assert.ok(/permissions to access records/.test(src), `${rel} denies with a real message`);
    }
    const act = fs.readFileSync(path.join(__dirname, '..', 'app', 'utils', 'activityLogger.js'), 'utf8');
    // strip comments so the explanatory note about the old bug is not matched
    const actCode = act.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/return reject\(/.test(actCode), 'activityLogger no longer calls an undefined reject');
    assert.ok(/logger\.warn/.test(act), 'it logs the reason instead');
  });
  await ok('payu init carries canonical 64-bit buyer id end to end', async () => {
    const crypto = require('crypto');
    const { initPayUPaymentFunc } = require('../app/controllers/payU');
    const req = { protocol: 'https', get: (h) => (h === 'host' ? 'vip.example.com' : undefined) };
    const body = {
      serverData: { tbl_name: 'sv_t', vip_days: 30, server_name: 'S', vip_price: 100, vip_currency: 'INR' },
      type: 'newPurchase', userFirstName: 'T', userEmail: 't@e.com', userMobile: '1',
    };
    const r = await withServerRow(INR_ROW, () => initPayUPaymentFunc(body, { id: '76561198092023766' }, 'k', req));
    assert.strictEqual(r.udf5, '76561198092023766');
    assert.ok(!/STEAM_/.test(r.udf5), 'no legacy id leaks to payu');
    // Recompute the hash over the documented formula to prove consistency.
    // The hashed amount must be the same fixed-2-decimal string sent in the form.
    const text = `${r.key}|${r.txnid}|100.00|30 days VIP for S (New Buy)|T|t@e.com|||||76561198092023766||||||`;
    const expect = crypto.createHash('sha512').update(text + require('../app/config').payment_gateways.payU.merchantSalt).digest('hex');
    assert.strictEqual(r.hash, expect);
  });
  await ok('admin vip add stores canonical 64-bit authId', async () => {
    const { EventEmitter } = require('events');
    const mod = (p) => path.join(__dirname, '..', 'app', p);
    const ctrlPath = mod('controllers/insertVip.js');
    const deps = [ctrlPath, mod('models/userModel.js'), mod('models/panelServerModal.js'), mod('models/vipModel.js'), require.resolve('rcon'), require.resolve('sourcequery')];
    const saved = {};
    for (const p of deps) saved[p] = require.cache[p];
    const setStub = (p, exp) => { require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
    const restore = () => {
      for (const p of Object.keys(saved)) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; }
      delete require.cache[ctrlPath];
    };
    let inserted = null;
    class FakeRcon extends EventEmitter {
      connect() { setImmediate(() => this.emit('auth')); }
      send() { setImmediate(() => { this.emit('response', 'ok'); this.emit('end'); }); }
      disconnect() {}
    }
    class FakeQ { open() {} getInfo(cb) { setImmediate(() => cb(null, {})); } close() {} }
    try {
      setStub(mod('models/userModel.js'), { getUserDataByUsername: async () => ({ sec_key: 'k' }) });
      setStub(mod('models/panelServerModal.js'), {
        getPanelServersDisplayList: async () => [{ tbl_name: 'sv_x' }],
        getPanelServerDetails: async () => ({ server_ip: 'h', server_port: '1', server_rcon_pass: 'p', rcon_refresh_cmd: null }),
      });
      setStub(mod('models/vipModel.js'), { insertVIPData: async (o) => { inserted = o; return true; } });
      setStub(require.resolve('rcon'), FakeRcon);
      setStub(require.resolve('sourcequery'), function FakeSQ() { return new FakeQ(); });
      delete require.cache[ctrlPath];
      const { insertVipDataFunc } = require('../app/controllers/insertVip.js');
      await insertVipDataFunc({ secKey: 'k', submit: 'insert', steamId: 'STEAM_1:0:65879019', name: 'T', flag: 'a', day: 1, server: ['sv_x'] }, 'u');
      assert.strictEqual(inserted.steamId, '"76561198092023766"');
      inserted = 'untouched';
      await insertVipDataFunc({ secKey: 'k', submit: 'insert', steamId: 'not-an-id!!!', name: 'T', flag: 'a', day: 1, server: ['sv_x'] }, 'u')
        .then(() => { throw new Error('should reject'); }, (e) => assert.ok(/Invalid Steam ID/i.test(String(e))));
      assert.strictEqual(inserted, 'untouched');
    } finally {
      restore();
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
  // The wizard persists to config.json now (CONFIG_PATH isolated here); the
  // legacy .env path must stay untouched to prove the .env-free install.
  const httpConfig = path.join(tmpDir, 'http-config.json');
  try { fs.unlinkSync(httpConfig); } catch (e) { /* absent */ }
  process.env.CONFIG_PATH = httpConfig;
  const httpEnv = path.join(tmpDir, 'http.env');
  try { fs.unlinkSync(httpEnv); } catch (e) { /* absent */ }
  process.env.DOTENV_PATH = httpEnv;
  for (const k of ['SETUP_COMPLETE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET', 'APP_SESSION_SECRET', 'STEAM_API_KEY', 'PUBLIC_BASE_URL']) delete process.env[k];
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
      const written = JSON.parse(fs.readFileSync(httpConfig, 'utf8'));
      assert.strictEqual(written.setupComplete, true);
      assert.strictEqual(written.db.db_host, 'wizard-host');
      assert.strictEqual(written.db.db_user, 'wizard-user');
      assert.strictEqual(written.db.db_name, 'vmpanel');
      assert.ok(written.jwt.key.length >= 64 && written.app.secret.length >= 64);
      assert.ok(!JSON.stringify(written).includes('twelve-chars-minimum'), 'admin password never lands in config');
      assert.ok(!fs.existsSync(httpEnv), 'wizard writes config.json, not .env');
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
      const httpConfigBak = process.env.CONFIG_PATH;
      for (const k of ['SETUP_COMPLETE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET', 'APP_SESSION_SECRET', 'STEAM_API_KEY', 'PUBLIC_BASE_URL']) delete process.env[k];
      process.env.CONFIG_PATH = path.join(tmpDir, 'incomplete.json');
      try { fs.unlinkSync(process.env.CONFIG_PATH); } catch (e) { /* absent */ }
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
        process.env.CONFIG_PATH = httpConfigBak;
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
