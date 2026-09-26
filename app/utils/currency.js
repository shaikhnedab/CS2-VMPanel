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
const INR_ONLY_GATEWAYS = ['payu', 'razorpay'];

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

module.exports = {
  SUPPORTED_CURRENCIES,
  FALLBACK_CURRENCY,
  normalizeCurrency,
  currencyForRow,
  resolveRowCurrency,
  isInrOnlyGateway,
  gatewaySupportsCurrency,
  unsupportedCurrencyMessage,
};
