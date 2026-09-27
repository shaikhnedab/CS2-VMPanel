/* PayPal order initialization.
 *
 * The PayPal button used to create its order client-side from the price in the
 * page. Settlement re-verified the captured amount against our database, so a
 * forged amount could not mint a discounted VIP - but a mismatch was only
 * discovered AFTER the money moved (paid, no VIP, no refund path), and the
 * client did a wasteful capture-then-server-capture dance. Creating the order
 * server-side, from our own row, means the charged amount is always right.
 */

'use strict';
const logger = require('../modules/logger')('PayPal controller');
const SteamIDConverter = require('../utils/steamIdConvertor');
const config = require('../config');
const { httpPostJson } = require('../utils/httpGet');
const { resolveRowCurrency, normalizeCurrency, formatAmount, gatewaySupportsCurrency, unsupportedCurrencyMessage } = require('../utils/currency');
const { paypalAccessToken, paypalBase, canVerifyPayPal, TIMEOUT_MS } = require('../modules/paymentVerify');

exports.initPayPalOrder = async (req, res) => {
  try {
    const result = await initPayPalOrderFunc(req.body, req.user);
    res.json({ success: true, data: { res: result, message: 'PayPal order created', notifType: 'success' } });
  } catch (error) {
    logger.error('error in initPayPalOrder->', error);
    // Never leak gateway internals; the buyer gets the plain reason.
    const msg = typeof error === 'string' ? error : 'Could not start PayPal checkout. Please try again.';
    res.json({ success: false, data: { error: msg } });
  }
};

const initPayPalOrderFunc = (reqBody, reqUser) => {
  return new Promise(async (resolve, reject) => {
    try {
      const cfg = config.payment_gateways.paypal;
      if (!canVerifyPayPal(cfg)) {
        return reject('PayPal is not configured. Please use another payment method.');
      }

      // Price the order from OUR row, never from the request - same rule as
      // the PayU/Razorpay init endpoints and settlement.
      const panelServerModal = require('../models/panelServerModal.js');
      const { TABLE_NAME_RE } = require('../models/myDashboardModel.js');
      let productData;
      if (reqBody.type === 'newPurchaseBundle') {
        const { getPanelBundlesListFunc } = require('./panelServerBundles.js');
        const bundles = await getPanelBundlesListFunc().catch(() => []);
        const wanted = String((reqBody.serverData || {}).bundle_name || (reqBody.serverData || {}).server_name || '');
        const chosen = (bundles || []).find((b) => String(b.bundle_name) === wanted);
        if (!chosen) return reject('Invalid bundle selection');
        if (Number(chosen.bundle_price) !== Number((reqBody.serverData || {}).vip_price)) return reject('Price mismatch, please retry');
        productData = {
          server_name: chosen.bundle_name,
          vip_price: chosen.bundle_price,
          vip_currency: chosen.bundle_currency,
          vip_days: chosen.bundle_sub_days,
        };
      } else {
        const tbls = String((reqBody.serverData || {}).tbl_name || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (tbls.length !== 1) return reject('Invalid server selection');
        if (!TABLE_NAME_RE.test(tbls[0])) return reject('Invalid server selection');
        const row = await panelServerModal.getPanelServerDetails(tbls[0]).catch(() => null);
        if (!row) return reject('Invalid server selection');
        if (Number(row.vip_price) !== Number((reqBody.serverData || {}).vip_price)) return reject('Price mismatch, please retry');
        if (String(row.vip_currency) !== String((reqBody.serverData || {}).vip_currency)) return reject('Currency mismatch');
        if (Number(row.vip_days) !== Number((reqBody.serverData || {}).vip_days)) return reject('Plan mismatch');
        productData = {
          server_name: row.server_name,
          vip_price: row.vip_price,
          vip_currency: row.vip_currency,
          vip_days: row.vip_days,
        };
      }
      if (!gatewaySupportsCurrency('paypal', productData.vip_currency)) {
        return reject(unsupportedCurrencyMessage('paypal', productData.vip_currency));
      }

      const buyerId64 = SteamIDConverter.toCanonical64(reqUser.id);
      const token = await paypalAccessToken(cfg);
      if (!token) return reject('Could not reach PayPal. Please try again.');
      const res = await httpPostJson(`${paypalBase(cfg.environment, cfg)}/v2/checkout/orders`, {
        intent: 'CAPTURE',
        purchase_units: [{
          description: `${productData.vip_days} days VIP for ${productData.server_name}`,
          custom_id: buyerId64,
          amount: {
            currency_code: normalizeCurrency(productData.vip_currency),
            value: formatAmount(productData.vip_price, productData.vip_currency),
          },
        }],
      }, { timeout: TIMEOUT_MS, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' } });
      if (!res.ok || !res.body || !res.body.id) {
        logger.error('paypal order create failed', res.error);
        return reject('Could not start PayPal checkout. Please try again.');
      }
      resolve({ orderID: String(res.body.id) });
    } catch (error) {
      logger.error('error in initPayPalOrderFunc->', error);
      reject('Could not start PayPal checkout. Please try again.');
    }
  });
};

exports.initPayPalOrderFunc = initPayPalOrderFunc;
