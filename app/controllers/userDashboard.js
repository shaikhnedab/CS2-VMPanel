/* VMP-by-Summer-Soldier
*
* Copyright (C) 2021 SUMMER SOLDIER - (SHIVAM PARASHAR)
*
* This file is part of VMP-by-Summer-Soldier
*
* VMP-by-Summer-Soldier is free software: you can redistribute it and/or modify it
* under the terms of the GNU General Public License as published by the Free
* Software Foundation, either version 3 of the License, or (at your option)
* any later version.
*
* VMP-by-Summer-Soldier is distributed in the hope that it will be useful, but WITHOUT
* ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
* FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License along with
* VMP-by-Summer-Soldier. If not, see http://www.gnu.org/licenses/.
*/

'use strict';
const logger = require('../modules/logger')('User Dashboard');
const { sendSafeError } = require('../utils/safeError');

const SteamIDConverter = require('../utils/steamIdConvertor')
const myDashboardModel = require("../models/myDashboardModel.js");
const salesModal = require("../models/salesModel.js");
const vipModel = require("../models/vipModel.js");
const { refreshBestEffort } = require("../utils/refreshCFGInServer")
const { gatewaySupportsCurrency, unsupportedCurrencyMessage } = require("../utils/currency")
const { verifyPayment, canVerify } = require("../modules/paymentVerify")
const { logThisActivity } = require("../utils/activityLogger.js");
const config = require('../config');
// Gateway config is read at call time, not captured at require time: an admin
// can change payment settings from the panel, and the store must reflect that
// without needing a process restart.
const gatewayCfg = () => config.payment_gateways;
const { getPanelBundlesListFunc } = require('./panelServerBundles.js')
const { sendBuyMessageOnDiscord } = require('./sendMessageOnDiscord.js')
const panelServerModal = require("../models/panelServerModal.js");
// Empty or example placeholder Client IDs count as "not configured" —
// otherwise the placeholder text leaks into the PayPal SDK URL and breaks
// checkout for installs that never set up PayPal.
const isRealPaypalClientId = (v) => {
  const s = String(v || '').trim();
  if (!s) return false;
  return !/your paypal|empty to disable|change-me|example/i.test(s);
};
exports.isRealPaypalClientId = isRealPaypalClientId;

//-----------------------------------------------------------------------------------------------------
// 

exports.myDashboard = async (req, res) => {
  try {
    let result = await myDashboardFunc(req.body, req.user);
    res.render('UserDashboard', result);
  } catch (error) {
    logger.error("error in myDashboard->", error);
    res.render('UserDashboard', { "userData": null });
  }
}

const myDashboardFunc = (reqBody, reqUser) => {
  return new Promise(async (resolve, reject) => {
    try {

      // Canonical 64-bit id for every downstream lookup. Profile extras are
      // best-effort: a missing photos array or realname must never throw and
      // wipe the whole dashboard (that surfaced as "you hold no VIP").
      const steamId = SteamIDConverter.toCanonical64(reqUser.id);
      const photoValues = Array.isArray(reqUser.photos)
        ? reqUser.photos.map((p) => p && p.value).filter(Boolean)
        : [];
      const userData = {
        "steamId": steamId,
        "displayname": reqUser.displayName || steamId,
        "realName": (reqUser._json && reqUser._json.realname) || '',
        "avatarUrl": photoValues[2] || photoValues[0] || ''
      }

      // The four fetches are independent — run them together instead of
      // sequentially so one slow query doesn't stall the whole page.
      const [userDataListing, serverList, allServerList, bundleList] = await Promise.all([
        myDashboardModel.getUserDataFromAllServers(steamId),
        myDashboardModel.getSaleServerListing(),
        // NOT getPanelServersList(): that is SELECT *, so the row carried
        // server_rcon_pass and the whole thing was embedded into the buyer's
        // /mydashboard HTML (the renew buttons serialise `serverdata`). The
        // sale projection deliberately omits the RCON secret.
        panelServerModal.getPanelServersSaleListing(),
        getPanelBundlesListFunc(),
      ]);

      const userServerArray = []
      // for (let j = 0; j < userDataListing.length; j++) {
      //   userServerArray.push(userDataListing[j].servername)
      // }

      for (let k = 0; k < userDataListing.length; k++) {
        userServerArray.push(userDataListing[k].servername)

        for (let l = 0; l < allServerList.length; l++) {
          if (userDataListing[k].servername == allServerList[l].server_name) {
            userDataListing[k].serverdata = allServerList[l]
          }
        }
      }

      // Servers on sale. Ones the viewer already holds VIP on are kept but
      // flagged `owned`, so the store can offer a gift path instead of
      // hiding them (hiding them made gifting-to-others impossible on a
      // single-server panel and looked like "no servers configured").
      const serverArray = []
      for (let i = 0; i < serverList.length; i++) {
        const row = serverList[i];
        if (userServerArray.includes(row.server_name)) {
          serverArray.push({ ...row, vmpOwned: true });
        } else {
          serverArray.push(row);
        }
      }

      const bundleArray = []
      for (let i = 0; i < bundleList.length; i++) {

        let serversTblNames = []
        for (let j = 0; j < bundleList[i].bundleServersData.length; j++) {
          serversTblNames.push(bundleList[i].bundleServersData[j].tbl_name)
        }

        let serverDataObj = {
          "id": bundleList[i].id,
          "server_ip": "-",
          "server_port": "-",
          "server_name": bundleList[i].bundle_name,
          // Explicit bundle key: settlement resolves the bundle by name to get
          // our own price/currency, and it used to look for `bundle_name` here,
          // which was never sent - so every bundle payment was captured and then
          // refused with "Invalid bundle selection".
          "bundle_name": bundleList[i].bundle_name,
          "vip_price": bundleList[i].bundle_price,
          "vip_currency": bundleList[i].bundle_currency,
          "vip_days": bundleList[i].bundle_sub_days,
          "tbl_name": serversTblNames.join(','),
          "vip_flag": bundleList[i].bundle_flags
        }

        bundleList[i]["serverDataObj"] = serverDataObj
        bundleArray.push(bundleList[i])

      }

      const giftingActive = !config.gifting || config.gifting.enabled !== false;
      // A gateway we cannot verify server-side must never be offered: taking
      // the money and then being unable to confirm it is worse than not
      // selling at all. canVerify() checks the merchant credentials are present
      // (Razorpay key secret, PayU key+salt, PayPal client id *and* secret).
      const verifying = config.verify_payments !== false;
      const gw = gatewayCfg();
      const paypalClientID = gw.paypal.paypal_client_id;
      const payuEnabled = (gw.payU.enabled == true || gw.payU.enabled == "true");
      const razorpayEnabled = (gw.razorPay.enabled == true || gw.razorPay.enabled == "true");

      const paypalConfigured = isRealPaypalClientId(paypalClientID);
      const paypalActive = verifying ? (paypalConfigured && canVerify('paypal')) : paypalConfigured;
      const payuActive = verifying ? (payuEnabled && canVerify('payu')) : payuEnabled;
      const razorpayActive = verifying ? (razorpayEnabled && canVerify('razorpay')) : razorpayEnabled;

      if (verifying) {
        if (paypalConfigured && !canVerify('paypal')) {
          logger.warn('PayPal is enabled but cannot be verified (paypal_client_secret missing) - hiding it from the store.');
        }
        if (payuEnabled && !canVerify('payu')) {
          logger.warn('PayU is enabled but cannot be verified (merchantKey/merchantSalt missing) - hiding it from the store.');
        }
        if (razorpayEnabled && !canVerify('razorpay')) {
          logger.warn('Razorpay is enabled but cannot be verified (keyId/keySecret missing) - hiding it from the store.');
        }
      }

      const colSpan = (arr) => (12 / (arr instanceof Array && arr.filter(i => !!i).length) || 1);

      resolve({
        "userDataListing": userDataListing,
        "userData": userData,
        "serverArray": serverArray,
        "bundleArray": bundleArray,
        "paypalActive": paypalActive,
        "paypalClientID": paypalClientID,
        "payuActive": payuActive,
        "payuEnv": gw.payU.environment,
        "razorpayActive": razorpayActive,
        "giftingActive": giftingActive,
        "colSpan": `${colSpan([paypalActive, payuActive, razorpayActive])}`
      })

    } catch (error) {
      logger.error("error in myDashboardFunc->", error);
      reject(error)
    }
  });
}

exports.myDashboardFunc = myDashboardFunc;
//-----------------------------------------------------------------------------------------------------

//-----------------------------------------------------------------------------------------------------
// 

exports.afterPaymentProcess = async (req, res) => {
  try {
    const secKey = req.session.passport.user.id
    let result = await afterPaymentProcessFunc(req.body, req.user, secKey);

    let userDisplayName = req.user.displayName
    userDisplayName = cleanString(userDisplayName)
    let userRealName = req.user._json.realname
    const finalUserName = userRealName + " - (" + (userDisplayName ? userDisplayName : "-_-") + ")"

    logThisActivity({
      "activity": req.body.isGift ? "VIP gifted" : req.body.buyType === 'newPurchase' ? "New VIP Purchased" : "VIP renewed",
      "additional_info": `${(req.body.gateway === 'paypal') ? req.body.paymentData.id : (req.body.gateway === 'payu') ? req.body.paymentData.order_id : "NA"} - ( ${finalUserName} )${req.body.isGift && req.body.recipientSteamId ? ` -> gift to ${req.body.recipientSteamId}` : ''}`,
      "created_by": finalUserName + " (Steam Login)"
    })

    sendBuyMessageOnDiscord(req.body, finalUserName)

    res.json({
      success: true,
      data: {
        "res": result,
        "message": "All Operations Done Successfully, Refreshing page in 5 Seconds",
        "notifType": "success"
      }
    });
  } catch (error) {
    logger.error("error in afterPaymentProcess->", error);
    return sendSafeError(req, res, error, "Payment processing failed. Contact support with the request ID if charged.");
  }
}

const afterPaymentProcessFunc = (reqBody, reqUser, secKey) => {
  return new Promise(async (resolve, reject) => {
    try {

      let userDisplayName = reqUser.displayName
      userDisplayName = cleanString(userDisplayName)
      let userRealName = reqUser._json.realname
      const finalUserName = userRealName + " - (" + (userDisplayName ? userDisplayName : "-_-") + ")"
      const saleType = (reqBody.buyType === 'newPurchase' || reqBody.buyType === "newPurchaseBundle") ? 1 : reqBody.buyType === 'renewPurchase' ? 2 : 0
      const serverTable = reqBody.serverData.tbl_name
      // NEVER take the SourceMod flag from the request. vip_flag is the
      // admin/immunity assignment the game server reads, so a crafted
      // vip_flag would let any buyer grant themselves an admin group for the
      // purchased period. It is resolved from our own row further down.
      let flag = null
      // The server row bound during quote validation, reused by verification
      // so a price edit cannot land between the two reads.
      let boundRow = null;
      const subDaysFromRow = (row) => (row && Number(row.vip_days)) || Number(reqBody.serverData.vip_days || 0)
      let subDays = (reqBody.serverData.vip_days / 1)
      const paymentData = reqBody.paymentData

      // Reject unknown purchase types and gateways up front, with a message
      // that says what is wrong. Without this an unknown buyType fell through
      // to sale_type 0 and died later as the opaque "Sale Type Missing", while
      // an unknown gateway reached the currency check (which passes anything
      // it does not recognise) and only failed at verification.
      const KNOWN_BUY_TYPES = ['newPurchase', 'renewPurchase', 'giftPurchase', 'newPurchaseBundle'];
      if (!KNOWN_BUY_TYPES.includes(reqBody.buyType)) return reject("Unknown purchase type");
      const KNOWN_GATEWAYS = ['paypal', 'payu', 'razorpay'];
      if (!KNOWN_GATEWAYS.includes(String(reqBody.gateway || '').toLowerCase())) return reject("Unknown payment gateway");

      // ---- Server-side quote validation (never trust client price/table/flag) ----
      const quotedAmount = Number(paymentData && (paymentData.amount_paid ?? (paymentData.purchase_units && paymentData.purchase_units[0] && paymentData.purchase_units[0].amount && paymentData.purchase_units[0].amount.value)));
      const quotedCurrency = paymentData && (paymentData.amount_currency ?? (paymentData.purchase_units && paymentData.purchase_units[0] && paymentData.purchase_units[0].amount && paymentData.purchase_units[0].amount.currency_code));
      const quotedOrderId = paymentData && (paymentData.order_id ?? paymentData.id);
      if (!quotedOrderId) return reject("Order Id Missing");
      const payStatus = String(paymentData && paymentData.status || '').toUpperCase();
      if (payStatus && !['COMPLETED', 'SUCCESS', 'CAPTURED', 'PAID'].includes(payStatus)) return reject("Payment not completed");
      // The amount/currency the browser reported are advisory only; they are
      // compared against the gateway's own numbers during verification below.
      // The duplicate check is deliberately NOT done on the browser's order id
      // here: it need not match the id the gateway actually confirms, so it was
      // both useless and bypassable. It runs once, on the verified id, below.

      if (reqBody.buyType === 'newPurchase' || reqBody.buyType === 'renewPurchase' || reqBody.buyType === 'giftPurchase') {
        const tbls = String(serverTable || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!tbls.length) return reject("Invalid server selection");
        // A non-bundle purchase covers exactly one server. Without this, a
        // crafted tbl_name of "sv_a,sv_b" buys two servers for one price
        // whenever they share a price and duration.
        if (tbls.length > 1) return reject("Invalid server selection");
        // Resolve each tbl_name from DB and enforce price/currency/days match.
        // giftPurchase belongs here too: it grants a VIP just like a purchase,
        // so it must not be able to skip the price/currency binding.
        // The bound row is kept for the verification step below: re-fetching
        // it there would let an admin price edit land between the check and
        // the charge comparison (fail-after-charge on a race nobody can see).
        for (const t of tbls) {
          const srv = await panelServerModal.getPanelServerDetails(t).catch(() => null);
          if (!srv) return reject("Invalid server selection");
          if (Number(srv.vip_price) !== Number(reqBody.serverData.vip_price)) return reject("Price mismatch, please retry");
          if (String(srv.vip_currency) !== String(reqBody.serverData.vip_currency)) return reject("Currency mismatch");
          if (Number(srv.vip_days) !== Number(reqBody.serverData.vip_days)) return reject("Plan mismatch");
          // The storefront only offers a gateway that can settle this row's
          // currency; re-check here so a crafted request cannot route a
          // non-INR server through an India-only gateway.
          if (!gatewaySupportsCurrency(reqBody.gateway, srv.vip_currency)) {
            return reject(unsupportedCurrencyMessage(reqBody.gateway, srv.vip_currency));
          }
          flag = srv.vip_flag;         // ours, not the browser's
          subDays = subDaysFromRow(srv)
          boundRow = srv;
        }
      }
      // Bundles are validated per-server inside the newPurchaseBundle branch via checkVipExists;
      // price binding for bundles resolves via getPanelBundlesListFunc below.

      // ---- Server-side payment verification (fail closed) ----
      // Everything above proves the *quote* was not tampered with. It says
      // nothing about whether the money arrived: paymentData comes from the
      // browser, so a forged { status: "SUCCESS" } would otherwise mint a free
      // VIP. Ask the gateway itself, using our own merchant credentials, and
      // compare its amount/currency against our DB price before granting
      // anything. A gateway we cannot verify is never offered at checkout, so
      // reaching here with one is a configuration or tampering problem.
      let expected = null;
      if (reqBody.buyType === 'newPurchase' || reqBody.buyType === 'renewPurchase' || reqBody.buyType === 'giftPurchase') {
        // Reuse the row bound above; a second fetch could observe a different
        // price than the one just validated.
        const srv = boundRow;
        if (!srv) return reject("Invalid server selection");
        expected = { amount: Number(srv.vip_price), currency: srv.vip_currency };
      } else if (reqBody.buyType === 'newPurchaseBundle') {
        const bundles = await getPanelBundlesListFunc();
        // The client sends `bundle_name`; older payloads only carried the name in
        // server_name, so accept either rather than refusing a paid bundle.
        const wanted = String((reqBody.serverData || {}).bundle_name || (reqBody.serverData || {}).server_name || '');
        const chosen = (bundles || []).find((b) => String(b.bundle_name) === wanted);
        if (!chosen) return reject("Invalid bundle selection");
        if (Number(chosen.bundle_price) !== Number(reqBody.serverData.vip_price)) return reject("Price mismatch, please retry");
        if (String(chosen.bundle_currency) !== String(reqBody.serverData.vip_currency)) return reject("Currency mismatch");
        expected = { amount: Number(chosen.bundle_price), currency: chosen.bundle_currency };
        flag = chosen.bundle_flags;      // ours, not the browser's
        subDays = subDaysFromRow({ vip_days: chosen.bundle_sub_days });
      }
      if (config.verify_payments !== false) {
        if (!expected) return reject("Could not determine what was purchased");
        const verdict = await verifyPayment({ gateway: reqBody.gateway, reqBody, expected });
        if (!verdict.ok) {
          // Never leak gateway internals to the buyer; log it, reject plainly.
          logger.error(`payment verification failed (${reqBody.gateway}) for order ${quotedOrderId}: ${verdict.reason}`);
          return reject(verdict.reason);
        }
        // Replay protection runs exactly once, on the id the GATEWAY confirmed.
        // It used to check "gateway:id" while the sales row stored the bare id,
        // so it could never match, and the browser's own order id was checked
        // earlier - which need not be the verified one, making both bypassable.
        // We store this same composite key, so the check and the stored value
        // can never drift apart again.
        if (verdict.orderId) {
          reqBody.verifiedOrderKey = `${reqBody.gateway}:${verdict.orderId}`;
          if (await salesModal.orderExists(reqBody.verifiedOrderKey)) {
            return reject("Duplicate payment: this order was already processed");
          }
        }
        reqBody.verifiedPayment = verdict;
      } else {
        logger.warn(`VERIFY_PAYMENTS is disabled - trusting the browser's claim for gateway ${reqBody.gateway}. Anyone can forge a payment.`);
      }
      if (!flag) return reject("Could not determine the server flag for this purchase");

      // ---- VIP gifting: optional recipient SteamID (else buyer). Never trust client payer. ----
      // `extendExisting` is derived below from the database, never from the
      // request: a forged flag would skip the insert and fail after the sale row
      // was written (money taken, no VIP).
      delete reqBody.extendExisting;
      const isGift = reqBody.isGift === true || reqBody.isGift === 'true' || reqBody.buyType === 'giftPurchase';
      if (isGift && config.gifting && config.gifting.enabled === false) {
        return reject("VIP gifting is disabled by the panel administrator");
      }
      // Stored canonically as 64-bit everywhere (sv_ rows + sales recipient).
      const buyerId64 = SteamIDConverter.toCanonical64(reqUser.id);
      let recipientSteamId64 = buyerId64;
      if (isGift) {
        const raw = String(reqBody.recipientSteamId || '').trim();
        if (!raw) return reject("Recipient SteamID is required for gifting");
        try {
          recipientSteamId64 = SteamIDConverter.toCanonical64(raw);
        } catch (e) { return reject("Invalid recipient SteamID format"); }
        if (recipientSteamId64 === buyerId64) return reject("Recipient matches buyer — use Buy instead of Gift");
        if (reqBody.buyType === 'renewPurchase') return reject("Gifts cannot renew; use new gift purchase");
      }
      const effectiveSaleType = isGift ? 3 : saleType;

      // Sales record. The security-relevant columns (order id, amount, currency,
      // status) come from the gateway's own verified answer when verification
      // ran, never from the browser. Descriptive columns (name/email/description)
      // are only ever displayed, so the client's copy is acceptable there.
      //
      // This replaces two hand-rolled hash blocks that were both wrong: the PayU
      // one built the reverse hash with 5 pipes and a single udf instead of the
      // documented 6 pipes and udf5..udf1, and the Razorpay one compared against
      // a `razorpay_signature` field the client never sends (it sends
      // razorpay_payment_signature), so both rejected every real payment.
      const v = reqBody.verifiedPayment;
      const src = reqBody.gateway === 'paypal' ? (paymentData || {})
        : reqBody.gateway === 'payu' ? (reqBody.payuData || {})
          : (reqBody.razorpayData || {});
      const payerBlock = (paymentData && paymentData.payer) || {};

      const payerEmail = payerBlock.email_address || src.email || paymentData.payer_email || null;
      const payerName = (payerBlock.name && payerBlock.name.given_name) || src.firstname || paymentData.payer_name || null;
      const payerSurname = (payerBlock.name && payerBlock.name.surname) || src.lastname || paymentData.payer_surname || null;
      const productDesc = (paymentData && paymentData.purchase_units && paymentData.purchase_units[0] && paymentData.purchase_units[0].description)
        || src.productinfo || paymentData.product_desc || null;

      const paymentInsertObj = {
        // The same composite key the duplicate check used, so the stored value
        // and the value we check can never diverge.
        order_id: reqBody.verifiedOrderKey || quotedOrderId,
        payer_id: v ? v.gatewayRef : (paymentData && (paymentData.payer_id || paymentData.payer)) || null,
        payer_steamid: buyerId64,
        recipient_steamid: isGift ? recipientSteamId64 : null,
        is_gift: isGift ? 1 : 0,
        payer_email: payerEmail,
        payer_name: payerName,
        payer_surname: payerSurname,
        product_desc: productDesc,
        amount_paid: v ? v.amount : quotedAmount,
        amount_currency: v ? v.currency : (quotedCurrency || null),
        status: v ? 'verified' : ((paymentData && paymentData.status) || null),
        sale_type: effectiveSaleType
      }

      // Grant target, declared BEFORE the pre-grant checks below because those
      // checks query by it. (It was previously declared after them, which made
      // every one of them throw a TDZ ReferenceError.)
      // Quoted canonical 64-bit target for sv_ rows (buyer or gift recipient).
      const vipTarget = '"' + (isGift ? recipientSteamId64 : buyerId64) + '"';
      // Steam display/real names are attacker-influenced and land in the sv_
      // name column (rendered by admin pages and the game plugin). Strip
      // control characters, collapse whitespace and cap the length so a
      // crafted profile cannot smuggle line breaks, terminal escapes or an
      // oversized value into the database.
      const cleanVipName = (s) => String(s == null ? '' : s).replace(/[\x00-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
      const vipName = isGift ? `//Gift for ${recipientSteamId64} (from ${cleanVipName(finalUserName)})` : "//" + cleanVipName(finalUserName);

      // ---- Pre-grant validation, BEFORE the sale row is written ----
      // These used to run after the insert, so a refusal (receiver already has
      // VIP, bundle mismatch) left a sale row with no VIP granted AND made every
      // retry fail as a duplicate: money captured, nothing delivered, unrecoverable.
      const singleServerTables = String(serverTable || '').split(',').map((s) => s.trim()).filter(Boolean)
      if (reqBody.buyType === 'giftPurchase') {
        for (const t of singleServerTables) {
          // Do NOT swallow a DB error: a swallowed failure reads as 'no existing
          // VIP' and lets a duplicate row through.
          const exists = await vipModel.checkVipExists({ server: t, steamId: vipTarget })
          if (exists && exists.name) return reject("Recipient already has VIP on one of these servers");
        }
      } else if (reqBody.buyType === 'newPurchase') {
        // Buying again when you already hold VIP is allowed and EXTENDS the
        // existing row (15 days left + a 30 day purchase = 45). It must never
        // insert a second row for the same authId: the game plugin would then
        // see two entries and the shorter one could expire out from under the
        // longer. The grant step below checks again and updates instead.
        for (const t of singleServerTables) {
          const exists = await vipModel.checkVipExists({ server: t, steamId: vipTarget })
          if (exists && exists.name) {
            reqBody.extendExisting = true;
            break;
          }
        }
      } else if (reqBody.buyType === 'renewPurchase') {
        const exists = await vipModel.checkVipExists({ server: singleServerTables[0], steamId: vipTarget })
        if (!exists || !exists.name) return reject("No VIP found to renew on this server");
      } else if (reqBody.buyType === 'newPurchaseBundle') {
        const bundleSets = await getPanelBundlesListFunc().catch(() => [])
        const tblSet = singleServerTables.slice().sort().join(',')
        const match = (bundleSets || []).find((b) => ((b.bundleServersData || []).map((s) => s.tbl_name).sort().join(',')) === tblSet
          && Number(b.bundle_price) === Number(reqBody.serverData.vip_price)
          && String(b.bundle_currency) === String(reqBody.serverData.vip_currency)
          && Number(b.bundle_sub_days) === Number(reqBody.serverData.vip_days));
        if (!match) return reject("Bundle price mismatch, please retry");
        reqBody.bundleServerArray = singleServerTables;
        // A gifted bundle must refuse BEFORE the sale row, for the same reason
        // as a single gift: the grant loop below would otherwise refuse
        // mid-loop, after earlier servers were already granted and the order
        // id was consumed (partial fulfillment + blocked retry).
        if (isGift) {
          for (const t of singleServerTables) {
            const exists = await vipModel.checkVipExists({ server: t, steamId: vipTarget });
            if (exists && exists.name) return reject("Recipient already has VIP on one of these servers");
          }
        }
      }

      // Only now is the order consumed. A duplicate key here means a concurrent
      // double-submit already wrote this order: the UNIQUE(order_id) constraint
      // (migration 001, and the fresh-install DDL) turns the check-then-insert
      // race into a safe failure instead of a double grant. Report it plainly
      // rather than leaking the raw database error to the buyer.
      const saleOrderId = paymentInsertObj.order_id;
      try {
        await salesModal.insertNewSaleRecord(paymentInsertObj, reqBody.gateway)
      } catch (e) {
        if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062 || /Duplicate entry/i.test(String((e && e.message) || e)))) {
          return reject("Duplicate payment: this order was already processed");
        }
        throw e;
      }
      // Grant tracking (migration 005): the sale row proves money moved, not
      // that the VIP was delivered. Every path below marks granted/failed so
      // support can tell the difference. Best-effort: tracking must never
      // break settlement, and setGrantStatus already swallows its own errors.
      const markGrant = (ok, err) => salesModal.setGrantStatus(saleOrderId, ok ? 'granted' : 'failed', err).catch(() => {});

      if (reqBody.buyType === 'newPurchase' || reqBody.buyType === 'giftPurchase') {

        // (recipient-already-has-VIP is checked above, before the sale row, so a
        //  refusal cannot burn the order id and block a legitimate retry)
        //
        // If the buyer already holds VIP on this server, EXTEND that row instead
        // of inserting a second one: 15 days left plus a 30 day purchase becomes
        // 45. Two rows for one authId would confuse the game plugin and the
        // shorter one could lapse while the buyer believes they are covered.
        if (reqBody.extendExisting) {
          const extended = await vipModel.updateVIPData({
            day: Math.floor(subDays * 86400),
            steamId: vipTarget,
            server: singleServerTables,
            secKey: secKey
          })
          if (!extended) {
            await markGrant(false, "extend failed");
            return reject("Could not extend the existing VIP. Contact support with your order reference.");
          }
          for (let i = 0; i < singleServerTables.length; i++) {
            await refreshBestEffort(singleServerTables[i]);
          }
          await markGrant(true);
          return resolve(extended);
        }

        const newVipInsertObj = {
          day: epochTillExpiry(subDays),
          name: vipName,
          steamId: vipTarget,
          userType: 0,
          flag: flag,
          server: serverTable.split(','),
          secKey: secKey
        }

        let insertRes = await vipModel.insertVIPData(newVipInsertObj)
        if (insertRes) {
          for (let i = 0; i < newVipInsertObj.server.length; i++) {
            await refreshBestEffort(newVipInsertObj.server[i]);
          }
          await markGrant(true);
          resolve(insertRes)
        } else {
          // A falsy grant must reject loudly with the order reference: the
          // sale row above is already written, so a silent hang leaves money
          // taken with no VIP and no message telling the buyer what to quote.
          await markGrant(false, "insert returned nothing");
          return reject("VIP grant failed after payment. Contact support with your order reference.");
        }
      } else if (reqBody.buyType === 'renewPurchase') {

        const updateVipObj = {
          day: Math.floor(subDays * 86400),
          // vipTarget, not a hardcoded buyer id: gifts cannot renew (rejected
          // above), so these are equal today, but a single derivation cannot
          // drift if that guard ever changes.
          steamId: vipTarget,
          server: [serverTable],
          secKey: secKey
        }

        let updateRes = await vipModel.updateVIPData(updateVipObj)
        if (updateRes) {
          for (let i = 0; i < updateVipObj.server.length; i++) {
            refreshBestEffort(updateVipObj.server[i]);
          }
          await markGrant(true);
          resolve(updateRes)
        } else {
          await markGrant(false, "renewal updated nothing");
          return reject("VIP renewal failed after payment. Contact support with your order reference.");
        }
      } else if (reqBody.buyType === 'newPurchaseBundle') {

        // The bundle quote was already validated against the DB above, before
        // the sale row was written.
        const bundleServerArray = reqBody.bundleServerArray

        // (gift recipient state was checked above, before the sale row.)
        const bundleFailures = [];
        for (let i = 0; i < bundleServerArray.length; i++) {

          let checkRes = await vipModel.checkVipExists({ server: bundleServerArray[i], steamId: vipTarget })

          if (checkRes && checkRes.name) {
            const updateVipObj = {
              day: Math.floor(subDays * 86400),
              steamId: vipTarget,
              server: [bundleServerArray[i]],
              secKey: secKey
            }

            let updateRes = await vipModel.updateVIPData(updateVipObj)
            if (updateRes) {
              refreshBestEffort(bundleServerArray[i]);
            } else {
              bundleFailures.push(bundleServerArray[i]);
            }
          } else {
            const newVipInsertObj = {
              day: epochTillExpiry(subDays),
              name: vipName,
              steamId: vipTarget,
              userType: 0,
              flag: flag,
              server: [bundleServerArray[i]],
              secKey: secKey
            }

            let insertRes = await vipModel.insertVIPData(newVipInsertObj)
            if (insertRes) {
              await refreshBestEffort(bundleServerArray[i]);
            } else {
              bundleFailures.push(bundleServerArray[i]);
            }
          }
        }
        // Never report success when a server was not granted: the buyer would
        // walk away believing all servers are covered. Name the failed ones so
        // support can grant exactly those.
        if (bundleFailures.length) {
          await markGrant(false, "bundle failed on " + bundleFailures.join(','));
          return reject("VIP grant failed on " + bundleFailures.join(', ') + " after payment. Contact support with your order reference.");
        }
        await markGrant(true);
        resolve(true)
      } else {
        reject("Something Went Wrong")
      }
    } catch (error) {
      logger.error("error in afterPaymentProcessFunc->", error);
      reject(error + ", Please try again")
    }
  });
}

exports.afterPaymentProcessFunc = afterPaymentProcessFunc;
//-----------------------------------------------------------------------------------------------------

function epochTillExpiry(days) {
  let currentEpoch = Math.floor(Date.now() / 1000)
  let daysInSec = Math.floor(days * 86400)
  return (currentEpoch + daysInSec)
}

function cleanString(input) {
  var output = "";
  for (var i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) <= 127) {
      output += input.charAt(i);
    }
  }
  return output;
}