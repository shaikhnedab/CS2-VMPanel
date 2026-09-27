'use strict';
/**
 * Settlement audit — read-only.
 *
 * Cross-references verified payments against live VIP rows to find money that
 * was captured but never delivered, plus a few structural problems that are easy
 * to miss by eye:
 *
 *   - duplicate authId rows on one server (the shorter row can lapse unnoticed)
 *   - VIP held with no matching sale on record
 *   - a configured server whose table does not exist
 *
 * It is deliberately SELECT-only and repairs nothing; it tells you what to look
 * at. Rows are reported, never changed.
 *
 * Usage
 *   Locally:   npm run audit
 *   Docker:    docker compose exec panel npm run audit
 *
 * It reads the same config and DB credentials the panel itself uses, so run it
 * with the same environment (inside the container, that is automatic).
 */
const path = require('path');

// Resolve the panel root from this file so the script works both in a checkout
// and inside the container (where the app lives at /app).
const ROOT = path.resolve(__dirname, '..', '..');

const config = require(path.join(ROOT, 'app', 'config'));
const dbBridge = require(path.join(ROOT, 'app', 'db', 'db_bridge'));
const connection = require(path.join(ROOT, 'app', 'db', 'connection'));

// Nothing here should be blocked by payment verification.
process.env.VERIFY_PAYMENTS = 'false';

const esc = (s) => String(s == null ? '' : s).replace(/[|`]/g, '').slice(0, 80);
const tbl = (n) => '`' + String(n).replace(/[^A-Za-z0-9_]/g, '') + '`';
const iso = (v) => (v instanceof Date ? v.toISOString() : String(v || '')).slice(0, 19).replace('T', ' ');
const isoDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
// sale_type: 1 = new purchase, 2 = renewal, 3 = gift
const KIND = { 1: 'BUY ', 2: 'RENEW', 3: 'GIFT' };

let errors = 0;
const say = (s) => console.log(s);
const rule = (t) => say('\n=== ' + t + ' ' + '='.repeat(Math.max(3, 66 - t.length)));

(async () => {
  const q = async (sql) => {
    const r = await dbBridge.query(sql);
    return Array.isArray(r) ? r : (r && r.rows) || [];
  };

  const salesTable = config.salestable;
  const serversTable = config.serverTable || 'tbl_servers';

  rule('1. Sales volume by day');
  say('   (no rows for recent days = the sales insert was not running)');
  try {
    const rows = await q(`SELECT DATE(created_on) AS day, status, sale_type, is_gift,
                                 COUNT(*) AS sales, GROUP_CONCAT(DISTINCT payment_gateway) AS gateways
                          FROM ${tbl(salesTable)}
                          GROUP BY day, status, sale_type, is_gift
                          ORDER BY day DESC LIMIT 30`);
    if (!rows.length) say('   (no sale rows at all)');
    else rows.forEach((r) => say(`   ${isoDay(r.day)}  status=${String(r.status).padEnd(10)} ${KIND[r.sale_type] || 'type' + r.sale_type} gift=${r.is_gift}  n=${r.sales}  via ${r.gateways}`));
  } catch (e) { errors++; say('   ERROR: ' + e.message); }

  rule('2. Verified payments');
  let verified = [];
  try {
    verified = await q(`SELECT id, created_on, payment_gateway, sale_type, is_gift,
                               payer_steamid, recipient_steamid, amount_paid, amount_currency, product_desc
                        FROM ${tbl(salesTable)}
                        WHERE LOWER(status) IN ('verified','success','captured','completed')
                        ORDER BY created_on DESC LIMIT 500`);
    if (!verified.length) say('   (none)');
    else verified.forEach((r) => say(
      `   #${String(r.id).padEnd(5)} ${iso(r.created_on)}  ${String(r.payment_gateway).padEnd(9)} ${KIND[r.sale_type] || 'type' + r.sale_type}` +
      `  ${String(r.amount_paid).padStart(6)} ${String(r.amount_currency).padEnd(4)} payer=${r.payer_steamid} recipient=${r.recipient_steamid || '-'} :: ${esc(r.product_desc)}`));
  } catch (e) { errors++; say('   ERROR: ' + e.message); }

  rule('3. Live VIP rows');
  const vipTables = [];
  try {
    const t = await q(`SELECT table_name AS t FROM information_schema.tables
                       WHERE table_schema = DATABASE() AND table_name LIKE 'sv\\_%' ORDER BY table_name`);
    vipTables.push(...t.map((r) => r.t || r.TABLE_NAME));
    say('   server tables: ' + (vipTables.join(', ') || '(none found)'));
  } catch (e) { errors++; say('   ERROR: ' + e.message); }

  const byAuth = new Map();       // authId -> [table]
  const byTableAuth = new Map();  // table|authId -> row
  for (const t of vipTables) {
    try {
      const rows = await q(`SELECT authId, name, expireStamp, vip_flag FROM ${tbl(t)}`);
      say(`\n   [${t}] ${rows.length} row(s)`);
      rows.forEach((r) => {
        const exp = Number(r.expireStamp) || 0;
        say(`     authId=${r.authId}  expires=${exp ? isoDay(new Date(exp * 1000)) : '?'}${exp && exp * 1000 < Date.now() ? '  EXPIRED' : ''}  flag=${r.vip_flag}  name=${esc(r.name)}`);
        const key = String(r.authId || '').replace(/"/g, '');
        if (!key) return;
        if (!byAuth.has(key)) byAuth.set(key, []);
        byAuth.get(key).push(t);
        byTableAuth.set(t + '|' + key, r);
      });
    } catch (e) { say(`     ERROR reading ${t}: ${e.message}`); }
  }

  rule('4. Delivered? each verified payment vs a live VIP row');
  say('   A renewal legitimately leaves a single row, so only MISSING is a problem.');
  let missing = 0, stale = 0;
  if (!verified.length) say('   nothing to reconcile');
  else for (const s of verified) {
    const who = String(s.recipient_steamid || s.payer_steamid || '').replace(/"/g, '');
    const where = byAuth.get(who);
    const kind = KIND[s.sale_type] || 'type' + s.sale_type;
    if (!where || !where.length) {
      missing++;
      say(`   MISSING  #${s.id} ${isoDay(s.created_on)} ${String(s.payment_gateway).padEnd(9)} ${kind} ${s.amount_paid} ${s.amount_currency}  no VIP row for ${who}  (${esc(s.product_desc)})`);
      continue;
    }
    // A renewal should have pushed the expiry past the day it was paid for.
    if (s.sale_type === 2) {
      const newest = where.map((t) => Number((byTableAuth.get(t + '|' + who) || {}).expireStamp) || 0)
        .reduce((a, b) => Math.max(a, b), 0);
      const paidFor = Math.floor(new Date(isoDay(s.created_on) + 'T00:00:00Z').getTime() / 1000);
      if (newest < paidFor) {
        stale++;
        say(`   STALE    #${s.id} ${isoDay(s.created_on)} ${String(s.payment_gateway).padEnd(9)} ${kind} ${s.amount_paid} ${s.amount_currency}  VIP on ${where.join(',')} expires ${isoDay(new Date(newest * 1000))} - not after the renewal`);
      }
    }
  }
  if (!missing && !stale) say('   every verified payment has a matching VIP row');
  else say(`\n   ${missing} payment(s) with NO VIP row, ${stale} renewal(s) that did not extend anything.`);

  rule('5. Configured servers vs tables that exist');
  try {
    const cfg = await q(`SELECT server_name, tbl_name FROM ${tbl(serversTable)}`);
    if (!cfg.length) say(`   (no rows in ${serversTable})`);
    else cfg.forEach((c) => {
      const t = String(c.tbl_name || '');
      say(`   ${t.padEnd(16)} (${c.server_name})  ${vipTables.includes(t) ? 'present' : 'MISSING TABLE'}`);
    });
  } catch (e) { say('   skipped (' + e.message + ')'); }

  rule('6. Duplicate VIP rows for one authId');
  let dupes = 0;
  for (const t of vipTables) {
    try {
      const d = await q(`SELECT authId, COUNT(*) AS n FROM ${tbl(t)} GROUP BY authId HAVING COUNT(*) > 1`);
      d.forEach((r) => { dupes++; say(`   ${t}: authId=${r.authId} has ${r.n} rows`); });
    } catch (e) { /* table may not have authId */ }
  }
  if (!dupes) say('   none');

  rule('7. VIP held but never sold for');
  const soldFor = new Set(verified.map((s) => String(s.recipient_steamid || s.payer_steamid || '').replace(/"/g, '')).filter(Boolean));
  let orphans = 0;
  for (const [auth, tables] of byAuth) {
    if (soldFor.has(auth)) continue;
    orphans++;
    say(`   ${auth} holds VIP on ${tables.join(', ')} with no verified sale on record`);
  }
  if (!orphans) say('   none');

  rule('SUMMARY');
  say(`   verified payments seen : ${verified.length}`);
  say(`   paid, nothing granted  : ${missing}`);
  say(`   renewals that did nothing: ${stale}`);
  say(`   live VIP identities    : ${byAuth.size}`);
  say(`   duplicate rows         : ${dupes}`);
  say(`   VIP with no sale       : ${orphans}`);
  say(`   server tables          : ${vipTables.length}`);
  say('\n   Read-only: nothing was modified. Section 4 is the one that needs action —');
  say('   those payments were captured but never delivered, so refund or grant by hand.');

  try { await connection.closePool(); } catch (e) { /* ignore */ }
  process.exit(errors === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('AUDIT ERROR:', e && (e.stack || e.message));
  try { await connection.closePool(); } catch (x) { /* ignore */ }
  process.exit(1);
});
