'use strict';

// Steam OpenID realm/return URLs derived per request.
//
// A static HOSTNAME-based URL breaks whenever the panel is reached on a
// different host or port than configured (direct IP:port access, container
// hostnames, reverse proxies) — Steam then redirects the user to a dead
// address and login fails. req.protocol honors X-Forwarded-Proto when trust
// proxy is enabled; req host carries the port the browser actually used.

const SteamStrategy = require('passport-steam');

function steamBaseUrl(req) {
  const proto = (req && req.protocol) || 'http';
  const host = (req && typeof req.get === 'function' && req.get('host')) || 'localhost';
  return `${proto}://${host}`;
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

module.exports = { steamBaseUrl, steamReturnUrl, steamRealm, buildSteamStrategy };
