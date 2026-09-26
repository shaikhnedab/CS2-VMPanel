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
const logger = require('../modules/logger')('pay U controller');
const SteamIDConverter = require('../utils/steamIdConvertor')
const crypto = require('crypto');
const config = require('../config');
const payUConfig = config.payment_gateways.payU

//-----------------------------------------------------------------------------------------------------
// 

exports.initPayUPayment = async (req, res) => {
  try {
    const secKey = req.session.passport.user.id
    let result = await initPayUPaymentFunc(req.body, req.user, secKey, req);

    res.json({
      success: true,
      data: {
        "res": result,
        "message": "PayU initiated",
        "notifType": "success"
      }
    });
  } catch (error) {
    logger.error("error in add/update vip->", error);
    res.json({
      success: false,
      data: { "error": error }
    });
  }
}

// PayU redirects the buyer back to surl/furl after checkout. These handlers only
// render an informational page: the VIP itself is granted by the browser's
// verified /execafterpaymentprocess call, so nothing is issued here. Without
// these routes the buyer landed on the panel's 404 after paying.
const payuReturn = (outcome) => (req, res) => {
  try {
    return res.render('PayUReturn', {
      outcome,
      // Echoed back by PayU as query params; display-only and length-capped so a
      // crafted return URL cannot inject anything into the page.
      txnStatus: String(req.query.txnStatus || '').slice(0, 32),
      txnid: String(req.query.txnid || req.query.payuMoneyId || '').slice(0, 64),
    });
  } catch (error) {
    logger.error("error in payu return page->", error);
    return res.status(500).send("Payment return page unavailable. Please check your dashboard.");
  }
};

exports.payuReturnSuccess = payuReturn('success');
exports.payuReturnError = payuReturn('error');

const initPayUPaymentFunc = (reqBody, reqUser, secKey, req) => {  return new Promise(async (resolve, reject) => {
    try {

      // Canonical 64-bit buyer id: goes into the hash input and udf5 alike,
      // so PayU echoes back exactly what we signed.
      const steamId = SteamIDConverter.toCanonical64(reqUser.id);

      // Price the order from OUR row, never from the request. This value is
      // about to be signed with the merchant key, so a client-supplied amount
      // would be an attacker-chosen figure authenticated by us. Settlement
      // re-checked the amount later, but a merchant-signed artefact for the wrong
      // price is exactly the kind of thing a future change turns into a discount.
      const panelServerModal = require('../models/panelServerModal.js');
      const { TABLE_NAME_RE } = require('../models/myDashboardModel.js');
      const requested = String((reqBody.serverData || {}).tbl_name || '').split(',')[0].trim();
      if (!TABLE_NAME_RE.test(requested)) return reject("Invalid server selection");
      const row = await panelServerModal.getPanelServerDetails(requested).catch(() => null);
      if (!row) return reject("Invalid server selection");
      const productData = {
        server_name: row.server_name,
        vip_price: row.vip_price,
        vip_currency: row.vip_currency,
        vip_days: row.vip_days,
      };
      let productInfo = productData.vip_days + " days VIP for " + productData.server_name + (reqBody.type == 'newPurchase' ? " (New Buy)" : reqBody.type == 'renewPurchase' ? " (Renewal)" : "")

      // PayU/BOLT settles in INR only and takes no currency parameter, so a
      // server priced in another currency would be charged a rupee amount
      // under a foreign label. Refuse instead of taking the money.
      const { resolveRowCurrency, gatewaySupportsCurrency, unsupportedCurrencyMessage, formatAmount } = require('../utils/currency');
      const payuCurrency = await resolveRowCurrency(productData);
      if (!gatewaySupportsCurrency('payu', payuCurrency)) {
        return reject(unsupportedCurrencyMessage('payu', payuCurrency));
      }

      // The amount is hashed, so the exact same string must go into the hash and
      // into the form field. PayU's documented example is fixed-2-decimal
      // ("10.00"), and an unformatted "30" can hash differently from what PayU
      // reconstructs, so format once and reuse.
      const amountStr = formatAmount(productData.vip_price, payuCurrency);

      let txnID = createTXNid()
      // PayU return URLs follow the configured PUBLIC_BASE_URL, else the
      // address the buyer actually used (never a static HOSTNAME, and https
      // aware behind a TLS proxy). The panel must be publicly reachable.
      const { resolveBaseUrl } = require('../utils/publicUrl');
      const base = resolveBaseUrl(req);
      let successURL = base + '/txnsuccesspayu'
      let errorURL = base + '/txnerrorpayu'

      let crypt = crypto.createHash('sha512');
      let text = payUConfig.merchantKey + '|' + txnID + '|' + amountStr + '|' + productInfo + '|' + reqBody.userFirstName + '|' + reqBody.userEmail + '|||||' + steamId + '||||||' + payUConfig.merchantSalt;
      crypt.update(text);
      let payUHash = crypt.digest('hex');

      let payuFormData = {
        "key": payUConfig.merchantKey,
        "txnid": txnID,
        "hash": payUHash,
        "amount": amountStr,
        "firstname": reqBody.userFirstName,
        "email": reqBody.userEmail,
        "phone": reqBody.userMobile,
        "productinfo": productInfo,
        "udf5": steamId,
        "surl": successURL,
        "furl": errorURL
      }

      resolve(payuFormData)
    } catch (error) {
      logger.error("error in initPayUPaymentFunc->", error);
      reject(error + ", Please try again")
    }
  });
}

exports.initPayUPaymentFunc = initPayUPaymentFunc;
//-----------------------------------------------------------------------------------------------------

function createTXNid() {
  let txID = 'PAYUORD-'
  txID += randomString(2)
  const now = new Date()
  const secondsSinceEpoch = Math.round(now.getTime() / 1000)
  txID += secondsSinceEpoch
  return txID
}

function randomString(length) {
  var result = '';
  var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var charactersLength = characters.length;
  for (var i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}