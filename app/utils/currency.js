'use strict';

/**
 * Currency rules for the store.
 *
 * A panel can sell in more than one currency: each server (and bundle) row
 * carries its own `vip_currency`, so an international server can be priced in
 * USD while an Indian one is priced in INR. The panel's `platform_currency`
 * setting is the *default* used for new rows (and the fallback for rows that
 * never got one) — it no longer overrides what a server declares.
 *
 * The important constraint is that not every gateway can settle every
 * currency:
 *   - Razorpay and PayU/BOLT are India-only and settle INR alone. Pointing
 *     either at a USD server makes Razorpay reject the order, and makes PayU
 *     quietly charge a rupee amount under a dollar label.
 *   - PayPal is multi-currency and can charge whatever the row declares.
 *
 * So the storefront only offers a gateway when it supports that row's
 * currency, and the settlement controllers re-check server-side (the view gate
 * is cosmetic and must never be the only guard).
 */

// Kept in sync with the admin currency pickers.
const SUPPORTED_CURRENCIES = ['USD', 'INR'];
const FALLBACK_CURRENCY = 'USD';

// Gateways that can only settle in one currency.
//
// PayU: this integration is PayU *India* (docs.payu.in), whose hosted/BOLT
// checkout and verify_payment API settle in INR only, so a non-INR server must
// be refused rather than charged a rupee amount under a foreign label.
//
// Razorpay is deliberately NOT in this list. Razorpay supports 160+ currencies
// on Payment Gateway / Checkout via International Payments (settlement still
// lands as INR), and explicitly documents passing e.g. `USD` with the amount in
// cents. Treating it as INR-only was based on outdated information and would
// needlessly block legitimate multi-currency sellers.
const INR_ONLY_GATEWAYS = ['payu'];

// Minor-unit exponent (decimal places) per currency. Gateways that expect the
// smallest sub-unit need this: most currencies are 2, but Razorpay documents
// 0-decimal (JPY, KRW, VND, CLP...) and 3-decimal (KWD, BHD, OMR, JOD, TND,
// IQD) currencies too. Anything unlisted defaults to 2.
const MINOR_UNIT_EXPONENTS = {
  BHD: 3, CLP: 0, IQD: 3, JOD: 3, JPY: 0, KMF: 0, KRW: 0, KWD: 3,
  OMR: 3, PYG: 0, RWF: 0, TND: 3, UGX: 0, VUV: 0, VND: 0, XAF: 0, XOF: 0, XPF: 0,
};
const DEFAULT_EXPONENT = 2;

/** Normalise to the 3-letter uppercase form the gateways expect. */
function normalizeCurrency(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : null;
}

/**
 * The currency a given server/bundle row is sold in. The row wins; the panel
 * setting is only a default for rows that never declared one.
 * @param {Object} [row] server or bundle data with a `vip_currency`
 * @param {string} [platformCurrency] already-loaded platform setting
 * @returns {string} 3-letter code
 */
function currencyForRow(row, platformCurrency) {
  return normalizeCurrency(row && row.vip_currency)
    || normalizeCurrency(platformCurrency)
    || FALLBACK_CURRENCY;
}

/**
 * Same as currencyForRow, but reads the panel setting from the DB when the
 * caller has not already loaded it.
 * @returns {Promise<string>}
 */
async function resolveRowCurrency(row, platformCurrency) {
  const own = normalizeCurrency(row && row.vip_currency);
  if (own) return own;
  let platform = normalizeCurrency(platformCurrency);
  if (!platform) {
    try {
      const settingsModal = require('../models/panelSettingModal.js');
      const settings = await settingsModal.getAllSettings();
      platform = normalizeCurrency(settings && settings.platform_currency);
    } catch (e) { /* fall through to the default */ }
  }
  return platform || FALLBACK_CURRENCY;
}

/** True when `gateway` can only settle in INR. */
function isInrOnlyGateway(gateway) {
  return INR_ONLY_GATEWAYS.includes(String(gateway || '').toLowerCase());
}

/**
 * Whether `gateway` is able to charge `currency` at all.
 * PayPal handles any supported currency; the India-only gateways require INR.
 */
function gatewaySupportsCurrency(gateway, currency) {
  const cur = normalizeCurrency(currency);
  if (!cur || !SUPPORTED_CURRENCIES.includes(cur)) return false;
  return isInrOnlyGateway(gateway) ? cur === 'INR' : true;
}

/** Human-readable reason a gateway cannot be used for a currency. */
function unsupportedCurrencyMessage(gateway, currency) {
  const name = String(gateway || '').toLowerCase() === 'razorpay' ? 'Razorpay' : 'PayU';
  return `${name} can only charge in INR, but this server is priced in ${normalizeCurrency(currency) || currency}. `
    + `Set the server currency to INR, or use PayPal for ${normalizeCurrency(currency) || currency}.`;
}

/**
 * Decimal places the currency's smallest sub-unit uses. Razorpay requires the
 * amount in that unit and rejects orders sent with the wrong exponent.
 */
function minorUnitExponent(currency) {
  const cur = normalizeCurrency(currency);
  if (!cur) return DEFAULT_EXPONENT;
  return Object.prototype.hasOwnProperty.call(MINOR_UNIT_EXPONENTS, cur)
    ? MINOR_UNIT_EXPONENTS[cur]
    : DEFAULT_EXPONENT;
}

/** Convert a major-unit amount to the smallest sub-unit (Razorpay Orders API). */
function toMinorUnits(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new TypeError(`toMinorUnits: not a number: ${amount}`);
  return Math.round(n * Math.pow(10, minorUnitExponent(currency)));
}

/** Inverse of toMinorUnits, for comparing a gateway's amount to our price. */
function fromMinorUnits(minor, currency) {
  const n = Number(minor);
  if (!Number.isFinite(n)) throw new TypeError(`fromMinorUnits: not a number: ${minor}`);
  return n / Math.pow(10, minorUnitExponent(currency));
}

/**
 * Fixed-decimal string for a currency. PayU's documented hash example uses
 * "10.00", and the amount string is hashed, so a stable representation matters.
 */
function formatAmount(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new TypeError(`formatAmount: not a number: ${amount}`);
  return n.toFixed(minorUnitExponent(currency));
}

module.exports = {
  SUPPORTED_CURRENCIES,
  FALLBACK_CURRENCY,
  MINOR_UNIT_EXPONENTS,
  normalizeCurrency,
  currencyForRow,
  resolveRowCurrency,
  isInrOnlyGateway,
  gatewaySupportsCurrency,
  unsupportedCurrencyMessage,
  minorUnitExponent,
  toMinorUnits,
  fromMinorUnits,
  formatAmount,
};
