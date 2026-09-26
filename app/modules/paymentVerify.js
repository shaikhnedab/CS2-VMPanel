'use strict';

/**
 * Server-side payment verification.
 *
 * Without this, /execafterpaymentprocess trusts whatever the browser posts:
 * `paymentData.status` is client-controlled, so anyone could craft a payload
 * with a made-up order id and a "SUCCESS" status and receive a free VIP. The
 * price/currency/days checks in the controller protect against *tampering with
 * the quote*, but they prove nothing about whether money actually arrived.
 *
 * So before any VIP is granted, each gateway is asked, over the network, using
 * the merchant's own credentials:
 *
 *   Razorpay  - the client sends razorpay_payment_signature, verified locally
 *               with HMAC-SHA256(payment_id|order_id, keySecret). That proves
 *               the parameters were not altered, but NOT that the payment was
 *               captured, so we also fetch the payment from Razorpay and require
 *               status "captured" with our exact amount and currency.
 *
 *   PayU      - this is PayU India, which settles INR only. Two independent
 *               checks: (1) the documented reverse hash over the response,
 *               sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|
 *               productinfo|amount|txnid|key), proves the response is PayU's and
 *               untampered; (2) the verify_payment API, which PayU recommends
 *               for reconciliation, proves the transaction is actually
 *               successful server-side.
 *
 *   PayPal    - requires a client secret to mint an OAuth token, then reads
 *               (and where needed captures) the order via the Orders v2 API and
 *               requires status COMPLETED with our amount and currency.
 *
 * Every failure is fail-closed: we reject rather than guess. A gateway that is
 * enabled but cannot be verified (missing secret, unverifiable currency, API
 * unreachable) must not be offered at checkout, so `canVerify()` is consulted
 * when building the store.
 */

const crypto = require('crypto');
const { httpGet, httpPostForm, httpPostJson } = require('../utils/httpGet');
const { toMinorUnits, fromMinorUnits, minorUnitExponent, normalizeCurrency, resolveRowCurrency } = require('../utils/currency');
const logger = require('./logger')('PaymentVerify');

const TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const sha512 = (text) => crypto.createHash('sha512').update(String(text)).digest('hex');

/** Constant-time compare that tolerates length/format differences. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a), 'utf8');
  const y = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const ok = (info = {}) => ({ ok: true, ...info });
const bad = (reason) => ({ ok: false, reason });

/** Compare a gateway amount to our price without float drift. */
function amountMatches(gatewayAmount, expectedAmount, currency) {
  const a = Number(gatewayAmount);
  const e = Number(expectedAmount);
  if (!Number.isFinite(a) || !Number.isFinite(e)) return false;
  // Gateways report either major units ("30", "30.00") or minor units (3000).
  // Normalise both to the minor unit and compare exactly.
  const exp = toMinorUnits(e, currency);
  const direct = Math.round(a * Math.pow(10, minorUnitExponent(currency)));
  const asMinor = Math.round(a);
  return direct === exp || asMinor === exp;
}

// ---------------------------------------------------------------------------
// Razorpay
// ---------------------------------------------------------------------------

const razorpayBase = (environment) => (String(environment).toLowerCase() === 'live'
  ? 'https://api.razorpay.com/v1'
  : 'https://api.razorpay.com/v1'); // same host; the key decides the mode

/** Can we actually verify Razorpay payments? */
function canVerifyRazorpay(cfg) {
  return !!(cfg && cfg.enabled && cfg.keyId && cfg.keySecret);
}

async function verifyRazorpay({ reqBody, expected, cfg }) {
  if (!canVerifyRazorpay(cfg)) {
    return bad('Razorpay cannot be verified: key_id/key_secret missing. Refusing to grant the VIP unverified.');
  }
  const live = reqBody.razorpayData || {};
  const paymentId = live.razorpay_payment_id || (reqBody.paymentData && reqBody.paymentData.payer_id);
  const orderId = live.razorpay_order_id || (reqBody.paymentData && reqBody.paymentData.order_id);
  const signature = live.razorpay_payment_signature;
  if (!paymentId || !orderId) return bad('Razorpay payment reference missing');

  // 1. Local signature check: HMAC-SHA256(payment_id + "|" + order_id, key_secret)
  if (!signature) return bad('Razorpay payment signature missing - refusing an unverified payment');
  const expectedSig = crypto.createHmac('sha256', cfg.keySecret)
    .update(`${paymentId}|${orderId}`)
    .digest('hex');
  if (!safeEqual(signature, expectedSig)) {
    return bad('Razorpay payment signature does not match');
  }

  // 2. Authoritative check with Razorpay: the signature alone cannot prove the
  //    payment was captured.
  let Razorpay;
  try {
    Razorpay = require('razorpay');
  } catch (e) {
    return bad('Razorpay SDK unavailable, cannot verify payment');
  }
  const instance = new Razorpay({ key_id: cfg.keyId, key_secret: cfg.keySecret });
  let payment;
  try {
    payment = await instance.payments.fetch(paymentId);
  } catch (e) {
    logger.error('razorpay payments.fetch failed', e && e.message);
    return bad('Could not confirm the payment with Razorpay. Contact support if you were charged.');
  }
  if (!payment || payment.status !== 'captured') {
    return bad(`Razorpay payment is not captured (status: ${(payment && payment.status) || 'unknown'})`);
  }
  if (String(payment.order_id) !== String(orderId)) {
    return bad('Razorpay payment does not belong to the quoted order');
  }
  if (!amountMatches(fromMinorUnits(payment.amount, payment.currency), expected.amount, expected.currency)) {
    return bad('Razorpay amount does not match the quoted price');
  }
  if (normalizeCurrency(payment.currency) !== normalizeCurrency(expected.currency)) {
    return bad('Razorpay currency does not match the quoted price');
  }
  return ok({
    orderId: String(orderId),
    gatewayRef: String(paymentId),
    amount: expected.amount,
    currency: normalizeCurrency(expected.currency),
    method: 'razorpay',
  });
}

// ---------------------------------------------------------------------------
// PayU (PayU India - INR settlement)
// ---------------------------------------------------------------------------

const payuPostservice = (environment) => (String(environment).toLowerCase() === 'live'
  ? 'https://info.payu.in/merchant/postservice.php?form=2'
  : 'https://test.payu.in/merchant/postservice.php?form=2');

function canVerifyPayU(cfg) {
  return !!(cfg && cfg.enabled && cfg.merchantKey && cfg.merchantSalt);
}

/**
 * PayU's documented reverse hash over the response:
 * sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 */
function payuReverseHash(cfg, r) {
  const part = (v) => (v === undefined || v === null ? '' : String(v));
  const text = [
    cfg.merchantSalt, part(r.status), '', '', '', '', '',
    part(r.udf5), part(r.udf4), part(r.udf3), part(r.udf2), part(r.udf1),
    part(r.email), part(r.firstname), part(r.productinfo), part(r.amount),
    part(r.txnid), cfg.merchantKey,
  ].join('|');
  return sha512(text);
}

/** General command API hash: sha512(key|command|var1|salt). */
function payuCommandHash(cfg, command, var1) {
  return sha512([cfg.merchantKey, command, var1, cfg.merchantSalt].join('|'));
}

async function verifyPayU({ reqBody, expected, cfg }) {
  if (!canVerifyPayU(cfg)) {
    return bad('PayU cannot be verified: merchant key/salt missing. Refusing to grant the VIP unverified.');
  }
  const r = reqBody.payuData || {};
  const txnid = r.txnid || (reqBody.paymentData && reqBody.paymentData.payer_id);
  if (!txnid) return bad('PayU transaction id missing');

  // 1. Reverse hash - proves this response really came from PayU.
  if (!r.hash) return bad('PayU response hash missing - refusing an unverified payment');
  if (!safeEqual(r.hash, payuReverseHash(cfg, r))) {
    return bad('PayU response hash does not match');
  }
  if (String(r.status || '').toUpperCase() !== 'SUCCESS') {
    return bad(`PayU transaction status is ${r.status}, not SUCCESS`);
  }

  // 2. verify_payment API - proves the transaction succeeded at PayU, which the
  //    browser-supplied status cannot.
  const url = payuPostservice(cfg.environment);
  const res = await httpPostForm(url, {
    key: cfg.merchantKey,
    command: 'verify_payment',
    var1: txnid,
    hash: payuCommandHash(cfg, 'verify_payment', txnid),
  }, { timeout: TIMEOUT_MS, headers: { Accept: 'application/json' } });

  if (!res.ok) {
    logger.error('payu verify_payment transport failure', res.error);
    return bad('Could not confirm the payment with PayU. Contact support if you were charged.');
  }
  const body = (res.body && typeof res.body === 'object') ? res.body : {};
  // PayU answers 200 with { status: "failure", error_message: ... } on problems.
  if (String(body.status || '').toLowerCase() !== 'success') {
    return bad(`PayU could not verify this transaction (${body.error_message || body.error_code || 'unknown error'})`);
  }
  const details = body.transaction_details || {};
  if (String(details.status || '').toLowerCase() !== 'success') {
    return bad('PayU reports this transaction was not successful');
  }
  if (!amountMatches(details.amount, expected.amount, expected.currency)) {
    return bad('PayU amount does not match the quoted price');
  }
  return ok({
    orderId: String(txnid),
    gatewayRef: String(details.payuMoneyId || txnid),
    amount: Number(details.amount),
    currency: 'INR',
    method: 'payu',
  });
}

// ---------------------------------------------------------------------------
// PayPal
// ---------------------------------------------------------------------------

const paypalBase = (environment) => (String(environment).toLowerCase() === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com');

function canVerifyPayPal(cfg) {
  return !!(cfg && cfg.paypal_client_id && cfg.paypal_client_secret);
}

async function paypalAccessToken(cfg) {
  const basic = Buffer.from(`${cfg.paypal_client_id}:${cfg.paypal_client_secret}`).toString('base64');
  const res = await httpPostForm(`${paypalBase(cfg.environment)}/v1/oauth2/token`, {
    grant_type: 'client_credentials',
  }, { timeout: TIMEOUT_MS, headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' } });
  if (!res.ok || !res.body || !res.body.access_token) {
    logger.error('paypal oauth failed', res.error);
    return null;
  }
  return res.body.access_token;
}

async function verifyPayPal({ reqBody, expected, cfg }) {
  if (!canVerifyPayPal(cfg)) {
    return bad('PayPal cannot be verified: a PayPal client secret is required. Refusing to grant the VIP unverified.');
  }
  const orderId = (reqBody.paymentData && (reqBody.paymentData.id || reqBody.paymentData.order_id))
    || reqBody.paypalOrderId;
  if (!orderId) return bad('PayPal order id missing');

  const token = await paypalAccessToken(cfg);
  if (!token) return bad('Could not authenticate with PayPal. Contact support if you were charged.');

  const auth = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  let order = null;
  // Prefer capture when we can, so the money is actually moved server-side.
  const capture = await httpPostJson(`${paypalBase(cfg.environment)}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, { timeout: TIMEOUT_MS, headers: auth });
  if (capture.ok && capture.body) {
    order = capture.body;
  } else {
    // Already-captured (the JS SDK captures client-side) or not approvable: read it.
    const get = await httpGet(`${paypalBase(cfg.environment)}/v2/checkout/orders/${encodeURIComponent(orderId)}`, { timeout: TIMEOUT_MS, headers: auth });
    if (!get.ok || !get.body) {
      logger.error('paypal order fetch failed', get.error);
      return bad('Could not confirm the order with PayPal. Contact support if you were charged.');
    }
    order = get.body;
  }

  if (String(order.status || '').toUpperCase() !== 'COMPLETED') {
    return bad(`PayPal order is not completed (status: ${order.status || 'unknown'})`);
  }
  const unit = (order.purchase_units && order.purchase_units[0] && order.purchase_units[0].amount) || {};
  if (!amountMatches(unit.value, expected.amount, expected.currency)) {
    return bad('PayPal amount does not match the quoted price');
  }
  if (normalizeCurrency(unit.currency_code) !== normalizeCurrency(expected.currency)) {
    return bad('PayPal currency does not match the quoted price');
  }
  const captureRef = order.purchase_units && order.purchase_units[0]
    && order.purchase_units[0].payments && order.purchase_units[0].payments.captures
    && order.purchase_units[0].payments.captures[0] && order.purchase_units[0].payments.captures[0].id;
  return ok({
    orderId: String(orderId),
    gatewayRef: String(captureRef || orderId),
    amount: Number(unit.value),
    currency: normalizeCurrency(unit.currency_code),
    method: 'paypal',
  });
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

/** Can `gateway` be verified with the current configuration? */
function canVerify(gateway, cfg = require('../config').payment_gateways) {
  switch (String(gateway || '').toLowerCase()) {
    case 'razorpay': return canVerifyRazorpay(cfg.razorPay);
    case 'payu': return canVerifyPayU(cfg.payU);
    case 'paypal': return canVerifyPayPal(cfg.paypal);
    default: return false;
  }
}

/**
 * Verify a claimed payment against the gateway.
 * @param {object} args
 * @param {string} args.gateway 'razorpay' | 'payu' | 'paypal'
 * @param {object} args.reqBody the raw settlement body from the browser
 * @param {object} args.expected { amount, currency } - our own DB price
 * @param {object} [args.cfg] payment_gateways config (defaults to app config)
 * @returns {Promise<{ok: boolean, reason?: string, orderId?: string, gatewayRef?: string}>}
 */
async function verifyPayment({ gateway, reqBody, expected, cfg }) {
  const config = cfg || require('../config').payment_gateways;
  const g = String(gateway || '').toLowerCase();
  const exp = { amount: Number(expected && expected.amount), currency: normalizeCurrency(expected && expected.currency) };
  if (!Number.isFinite(exp.amount)) return bad('Could not determine the expected amount');
  if (!exp.currency) return bad('Could not determine the expected currency');

  try {
    switch (g) {
      case 'razorpay': return await verifyRazorpay({ reqBody, expected: exp, cfg: config.razorPay });
      case 'payu': return await verifyPayU({ reqBody, expected: exp, cfg: config.payU });
      case 'paypal': return await verifyPayPal({ reqBody, expected: exp, cfg: config.paypal });
      default: return bad(`Unknown payment gateway: ${gateway}`);
    }
  } catch (e) {
    logger.error(`verification crashed for ${g}`, e && (e.stack || e.message));
    return bad('Payment verification failed. Contact support if you were charged.');
  }
}

module.exports = {
  verifyPayment,
  canVerify,
  canVerifyRazorpay,
  canVerifyPayU,
  canVerifyPayPal,
  payuReverseHash,
  payuCommandHash,
  amountMatches,
  razorpayBase,
  payuPostservice,
  paypalBase,
  TIMEOUT_MS,
};
