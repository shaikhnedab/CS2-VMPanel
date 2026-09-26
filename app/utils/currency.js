'use strict';

/**
 * Single source of truth for "what currency is this panel charging in?".
 *
 * The panel has one currency: `platform_currency` in panel settings (the admin
 * UI even prefills a new server's currency field from it). The per-server
 * `vip_currency` column is legacy and can disagree with it — rows created
 * before the setting existed still carry the old default.
 *
 * That disagreement is not cosmetic, it is a money bug:
 *   - Razorpay is India-only and accepts INR alone, so sending it a row's
 *     "USD" makes it reject the order outright.
 *   - PayU/BOLT sends no currency at all and settles in INR, so a "USD" label
 *     on the storefront misrepresents the charge.
 *   - PayPal is multi-currency and happily charges the row's "USD", which then
 *     contradicts what the INR-only gateways take for the same product.
 *
 * So: the panel currency wins everywhere, and the per-server value is used only
 * as a fallback for panels that never set one. Never trust a client-sent
 * currency for the charge.
 */

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
 * Resolve the currency to charge, given an optional server/bundle row.
 * @param {Object} [row] server data that may carry a legacy `vip_currency`
 * @param {string} [platformCurrency] override, e.g. from an already-loaded
 *        panelSetting; looked up from the DB when omitted
 * @returns {Promise<string>} ISO-4217-ish 3-letter code
 */
async function resolvePlatformCurrency(row, platformCurrency) {
  let platform = normalizeCurrency(platformCurrency);
  if (!platform) {
    try {
      const settingsModal = require('../models/panelSettingModal.js');
      const settings = await settingsModal.getAllSettings();
      platform = normalizeCurrency(settings && settings.platform_currency);
    } catch (e) { /* fall through to the row/default */ }
  }
  if (platform) return platform;
  return normalizeCurrency(row && row.vip_currency) || FALLBACK_CURRENCY;
}

/** True when `gateway` can only settle in INR. */
function isInrOnlyGateway(gateway) {
  return INR_ONLY_GATEWAYS.includes(String(gateway || '').toLowerCase());
}

module.exports = { resolvePlatformCurrency, normalizeCurrency, isInrOnlyGateway, FALLBACK_CURRENCY };
