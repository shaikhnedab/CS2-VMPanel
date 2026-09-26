'use strict';

// Steam OpenID realm/return URLs: explicit PUBLIC_BASE_URL when valid,
// otherwise derived per request (see ./publicUrl for the rationale).

const SteamStrategy = require('passport-steam');
const needle = require('needle');
const { normalizePublicBaseUrl, resolveBaseUrl } = require('./publicUrl');

// profile:false is deliberate: passport-steam's built-in enrichment calls
// the Steam Web API over raw http.get with NO timeout, so one stalled Steam
// response used to hang login indefinitely. We fetch the summary ourselves
// with bounded timeouts and fall back to a minimal profile, so login always
// completes — the dashboard only hard-requires the id.
const STEAM_OPENID_ID_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/;
const PROFILE_TIMEOUT_MS = 7000;

function parseSteamId64(identifier) {
  const m = String(identifier || '').match(STEAM_OPENID_ID_RE);
  return m ? m[1] : null;
}

function minimalProfile(id64, identifier) {
  const profile = {
    provider: 'steam',
    id: id64,
    displayName: id64,
    photos: [],
    _json: {},
  };
  if (identifier) profile.identifier = identifier;
  return profile;
}

// Bounded GetPlayerSummaries; resolves a passport-shaped profile, never rejects.
function fetchSteamProfile(apiKey, id64) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (profile) => { if (!settled) { settled = true; resolve(profile); } };
    if (!apiKey) return finish(minimalProfile(id64));
    try {
      needle.get(
        'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/',
        { key: apiKey, steamids: id64 },
        { open_timeout: PROFILE_TIMEOUT_MS, read_timeout: PROFILE_TIMEOUT_MS, response_timeout: PROFILE_TIMEOUT_MS },
        (err, res) => {
          try {
            const players = res && res.body && res.body.response && res.body.response.players;
            const p = Array.isArray(players) && players[0];
            if (err || !p || String(p.steamid) !== String(id64)) return finish(minimalProfile(id64));
            const photos = [p.avatar, p.avatarmedium, p.avatarfull].filter(Boolean).map((value) => ({ value }));
            return finish({
              provider: 'steam',
              id: String(p.steamid),
              displayName: p.personaname || String(id64),
              photos,
              _json: p,
            });
          } catch (e) {
            return finish(minimalProfile(id64));
          }
        }
      );
    } catch (e) {
      finish(minimalProfile(id64));
    }
  });
}

// A fresh instance per login request: passport-steam bakes returnURL/realm
// into its OpenID relying party at construction, so a shared singleton can
// never serve more than one public address. Construction is cheap; the
// in-flight request holds its own instance, so concurrent logins are safe.
// The per-instance closure captures that request's apiKey (no shared state).
function steamBaseUrl(req) {
  return resolveBaseUrl(req);
}

function steamReturnUrl(req) {
  return `${steamBaseUrl(req)}/auth/steam/return`;
}

function steamRealm(req) {
  return `${steamBaseUrl(req)}/`;
}

function buildSteamStrategy(returnURL, realm, apiKey) {
  function verify(identifier, profile, done) {
    const id64 = parseSteamId64(identifier);
    if (!id64) {
      return done(null, false, { message: 'Claimed identity is invalid.' });
    }
    fetchSteamProfile(apiKey, id64).then((built) => {
      built.identifier = identifier;
      return done(null, built);
    });
  }
  return new SteamStrategy({ returnURL, realm, apiKey, profile: false }, verify);
}

module.exports = { steamBaseUrl, steamReturnUrl, steamRealm, buildSteamStrategy, normalizePublicBaseUrl, parseSteamId64, fetchSteamProfile, minimalProfile, PROFILE_TIMEOUT_MS };
