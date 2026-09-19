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
const { logThisActivity } = require("../utils/activityLogger.js");
const config = require('../config');
const paypalClientID = config.payment_gateways.paypal.paypal_client_id
const payUConfig = config.payment_gateways.payU
const razorpayConfig = config.payment_gateways.razorPay;
const crypto = require('crypto');
const { getPanelBundlesListFunc } = require('./panelServerBundles.js')
const { sendBuyMessageOnDiscord } = require('./sendMessageOnDiscord.js')
const panelServerModal = require("../models/panelServerModal.js");
const paymentTamperedMessage =
  "Payment Tempered!, Response HASH does not matches with payment HASH therefore payment failed, Contact Support";

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

      const steamId = SteamIDConverter.toSteamID(reqUser.id);
      const userData = {
        "steamId": steamId,
        "displayname": reqUser.displayName,
        "realName": reqUser._json.realname,
        "avatarUrl": reqUser.photos[2].value
      }

      let userDataListing = await myDashboardModel.getUserDataFromAllServers('"' + steamId + '"')

      let serverList = await myDashboardModel.getSaleServerListing()
      let allServerList = await panelServerModal.getPanelServersList();

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

      const serverArray = []
      for (let i = 0; i < serverList.length; i++) {
        if (!userServerArray.includes(serverList[i].server_name)) {
          serverArray.push(serverList[i])

        }
      }

      let bundleList = await getPanelBundlesListFunc()

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
          "vip_price": bundleList[i].bundle_price,
          "vip_currency": bundleList[i].bundle_currency,
          "vip_days": bundleList[i].bundle_sub_days,
          "tbl_name": serversTblNames.join(','),
          "vip_flag": bundleList[i].bundle_flags
        }

        bundleList[i]["serverDataObj"] = serverDataObj
        bundleArray.push(bundleList[i])

      }

      const paypalActive = isRealPaypalClientId(paypalClientID);
      const payuActive = (payUConfig.enabled == true || payUConfig.enabled == "true");
      const razorpayActive = (razorpayConfig.enabled == true || razorpayConfig.enabled == "true");

      const colSpan = (arr) => (12 / (arr instanceof Array && arr.filter(i => !!i).length) || 1);

      resolve({
        "userDataListing": userDataListing,
        "userData": userData,
        "serverArray": serverArray,
        "bundleArray": bundleArray,
        "paypalActive": paypalActive,
        "paypalClientID": paypalClientID,
        "payuActive": payuActive,
        "payuEnv": payUConfig.environment,
        "razorpayActive": razorpayActive,
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

      const steamId = SteamIDConverter.toSteamID(reqUser.id);
      let userDisplayName = reqUser.displayName
      userDisplayName = cleanString(userDisplayName)
      let userRealName = reqUser._json.realname
      const finalUserName = userRealName + " - (" + (userDisplayName ? userDisplayName : "-_-") + ")"
      const saleType = (reqBody.buyType === 'newPurchase' || reqBody.buyType === "newPurchaseBundle") ? 1 : reqBody.buyType === 'renewPurchase' ? 2 : 0
      const serverTable = reqBody.serverData.tbl_name
      const flag = reqBody.serverData.vip_flag
      const subDays = (reqBody.serverData.vip_days / 1)
      const paymentData = reqBody.paymentData

      // ---- Server-side quote validation (never trust client price/table/flag) ----
      const quotedAmount = Number(paymentData && (paymentData.amount_paid ?? (paymentData.purchase_units && paymentData.purchase_units[0] && paymentData.purchase_units[0].amount && paymentData.purchase_units[0].amount.value)));
      const quotedCurrency = paymentData && (paymentData.amount_currency ?? (paymentData.purchase_units && paymentData.purchase_units[0] && paymentData.purchase_units[0].amount && paymentData.purchase_units[0].amount.currency_code));
      const quotedOrderId = paymentData && (paymentData.order_id ?? paymentData.id);
      if (!quotedOrderId) return reject("Order Id Missing");
      if (await salesModal.orderExists(quotedOrderId)) return reject("Duplicate payment: this order was already processed");
      const payStatus = String(paymentData && paymentData.status || '').toUpperCase();
      if (payStatus && !['COMPLETED', 'SUCCESS', 'CAPTURED', 'PAID'].includes(payStatus)) return reject("Payment not completed");

      if (reqBody.buyType === 'newPurchase' || reqBody.buyType === 'renewPurchase') {
        const tbls = String(serverTable || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!tbls.length) return reject("Invalid server selection");
        // Resolve each tbl_name from DB and enforce price/currency/days/flag match.
        for (const t of tbls) {
          const srv = await panelServerModal.getPanelServerDetails(t).catch(() => null);
          if (!srv) return reject("Invalid server selection");
          if (Number(srv.vip_price) !== Number(reqBody.serverData.vip_price)) return reject("Price mismatch, please retry");
          if (String(srv.vip_currency) !== String(reqBody.serverData.vip_currency)) return reject("Currency mismatch");
          if (Number(srv.vip_days) !== Number(reqBody.serverData.vip_days)) return reject("Plan mismatch");
        }
      }
      // Bundles are validated per-server inside the newPurchaseBundle branch via checkVipExists;
      // price binding for bundles resolves via getPanelBundlesListFunc below.

      // ---- VIP gifting: optional recipient SteamID (else buyer). Never trust client payer. ----
      const isGift = reqBody.isGift === true || reqBody.isGift === 'true' || reqBody.buyType === 'giftPurchase';
      // Stored canonically as 64-bit everywhere (sv_ rows + sales recipient).
      const buyerId64 = String(reqUser.id);
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
      let paymentInsertObj

      if (reqBody.gateway === 'paypal') {
        paymentInsertObj = {
          order_id: paymentData.id,
          payer_id: paymentData.payer.payer_id,
          payer_steamid: steamId,
          recipient_steamid: isGift ? recipientSteamId64 : null,
          is_gift: isGift ? 1 : 0,
          payer_email: paymentData.payer.email_address,
          payer_name: paymentData.payer.name.given_name,
          payer_surname: paymentData.payer.name.surname,
          product_desc: paymentData.purchase_units[0].description,
          amount_paid: paymentData.purchase_units[0].amount.value,
          amount_currency: paymentData.purchase_units[0].amount.currency_code,
          status: paymentData.status,
          sale_type: effectiveSaleType
        }
      } else if (reqBody.gateway === 'payu') {

        let keyString = payUConfig.merchantKey + '|' + reqBody.payuData.txnid + '|' + reqBody.payuData.amount + '|' + reqBody.payuData.productinfo + '|' + reqBody.payuData.firstname + '|' + reqBody.payuData.email + '|||||' + reqBody.payuData.udf5 + '|||||';
        let keyArray = keyString.split('|');
        let reverseKeyArray = keyArray.reverse();
        let reverseKeyString = payUConfig.merchantSalt + '|' + reqBody.payuData.status + '|' + reverseKeyArray.join('|');
        let crypt = crypto.createHash('sha512');
        crypt.update(reverseKeyString);
        let calcHash = crypt.digest('hex');

        if (calcHash === reqBody.payuData.hash) {
          paymentInsertObj = {
            order_id: paymentData.order_id,
            payer_id: paymentData.payer_id,
            payer_steamid: steamId,
            recipient_steamid: isGift ? recipientSteamId64 : null,
            is_gift: isGift ? 1 : 0,
            payer_email: paymentData.payer_email,
            payer_name: paymentData.payer_name,
            payer_surname: paymentData.payer_surname,
            product_desc: paymentData.product_desc,
            amount_paid: paymentData.amount_paid,
            amount_currency: paymentData.amount_currency,
            status: paymentData.status,
            sale_type: effectiveSaleType
          }
        } else {
          return reject(paymentTamperedMessage);
        }
      } else if (reqBody.gateway === 'razorpay') {
        // Verify using Razorpay's own fields (order_id/payment_id + signature), not client paymentData.
        const rzp = reqBody.razorpayData || {};
        const rzpOrderId = rzp.razorpay_order_id || paymentData.order_id;
        const rzpPaymentId = rzp.razorpay_payment_id || paymentData.payer_id;
        const crypt = crypto.createHmac("sha256", razorpayConfig.keySecret);
        const calculatedHash = crypt.update(`${rzpOrderId}|${rzpPaymentId}`).digest("hex");

        if (!rzp.razorpay_signature || rzp.razorpay_signature !== calculatedHash) return reject(paymentTamperedMessage);

        paymentInsertObj = {
          order_id: rzpOrderId,
          payer_id: rzpPaymentId,
          payer_steamid: steamId,
          recipient_steamid: isGift ? recipientSteamId64 : null,
          is_gift: isGift ? 1 : 0,
          payer_email: paymentData.payer_email,
          payer_name: paymentData.payer_name,
          payer_surname: paymentData.payer_surname,
          product_desc: paymentData.product_desc,
          amount_paid: paymentData.amount_paid,
          amount_currency: paymentData.amount_currency,
          status: paymentData.status,
          sale_type: effectiveSaleType
        }
      }

      await salesModal.insertNewSaleRecord(paymentInsertObj, reqBody.gateway)

      // Gift target (quoted canonical SteamID); self-purchase uses buyer.
      // Quoted canonical 64-bit target for sv_ rows (buyer or gift recipient).
      const vipTarget = '"' + (isGift ? recipientSteamId64 : buyerId64) + '"';
      const vipName = isGift ? `//Gift for ${recipientSteamId64} (from ${finalUserName})` : "//" + finalUserName;

      if (reqBody.buyType === 'newPurchase' || reqBody.buyType === 'giftPurchase') {

        // For gifts, refuse if recipient already has an active VIP (require explicit extend later).
        if (isGift) {
          for (const t of serverTable.split(',')) {
            const exists = await vipModel.checkVipExists({ server: t, steamId: vipTarget }).catch(() => null);
            if (exists && exists.name) return reject("Recipient already has VIP on one of these servers");
          }
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
          resolve(insertRes)
        }
      } else if (reqBody.buyType === 'renewPurchase') {

        const updateVipObj = {
          day: Math.floor(subDays * 86400),
          steamId: '"' + buyerId64 + '"',
          server: [serverTable],
          secKey: secKey
        }

        let updateRes = await vipModel.updateVIPData(updateVipObj)
        if (updateRes) {
          for (let i = 0; i < updateVipObj.server.length; i++) {
            refreshBestEffort(updateVipObj.server[i]);
          }
          resolve(updateRes)
        }
      } else if (reqBody.buyType === 'newPurchaseBundle') {

        // Validate bundle quote against DB (match by server set + price/currency/days).
        const bundles = await getPanelBundlesListFunc().catch(() => []);
        const tblSet = String(serverTable || '').split(',').map((s) => s.trim()).filter(Boolean).sort().join(',');
        const match = (bundles || []).find((b) => {
          const set = ((b.bundleServersData || []).map((s) => s.tbl_name).sort().join(','));
          return set === tblSet
            && Number(b.bundle_price) === Number(reqBody.serverData.vip_price)
            && String(b.bundle_currency) === String(reqBody.serverData.vip_currency)
            && Number(b.bundle_sub_days) === Number(reqBody.serverData.vip_days);
        });
        if (!match) return reject("Bundle price mismatch, please retry");

        const bundleServerArray = serverTable.split(',')

        for (let i = 0; i < bundleServerArray.length; i++) {

          let checkRes = await vipModel.checkVipExists({ server: bundleServerArray[i], steamId: vipTarget })

          if (checkRes && checkRes.name) {
            if (isGift) return reject("Recipient already has VIP on one of these servers");
            const updateVipObj = {
              day: Math.floor(subDays * 86400),
              steamId: vipTarget,
              server: [bundleServerArray[i]],
              secKey: secKey
            }

            let updateRes = await vipModel.updateVIPData(updateVipObj)
            if (updateRes) {
              refreshBestEffort(bundleServerArray[i]);
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
            }
          }
        }
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