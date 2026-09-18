'use strict';

// Steam OpenID realm/return URLs: explicit PUBLIC_BASE_URL when valid,
// otherwise derived per request (see ./publicUrl for the rationale).

const SteamStrategy = require('passport-steam');
const { normalizePublicBaseUrl, resolveBaseUrl } = require('./publicUrl');

function steamBaseUrl(req) {
  return resolveBaseUrl(req);
}

function steamReturnUrl(req) {
  return `${steamBaseUrl(req)}/auth/steam/return`;
}

function steamRealm(req) {
  return `${steamBaseUrl(req)}/`;
}

function verifySteamLogin(identifier, profile, done) {
  // asynchronous verification, for effect...
  process.nextTick(() => {
    profile.identifier = identifier;
    return done(null, profile);
  });
}

// A fresh instance per login request: passport-steam bakes returnURL/realm
// into its OpenID relying party at construction, so a shared singleton can
// never serve more than one public address. Construction is cheap; the
// in-flight request holds its own instance, so concurrent logins are safe.
function buildSteamStrategy(returnURL, realm, apiKey) {
  return new SteamStrategy({ returnURL, realm, apiKey }, verifySteamLogin);
}

module.exports = { steamBaseUrl, steamReturnUrl, steamRealm, buildSteamStrategy, normalizePublicBaseUrl };
