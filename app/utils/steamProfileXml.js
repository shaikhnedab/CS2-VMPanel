'use strict';

/**
 * Steam `?xml=1` profile parsing.
 *
 * Steam returns XML, and depending on the HTTP client it arrives either as a
 * raw string or as a pre-parsed object with a `children` array. Both shapes are
 * accepted here so callers never have to care which one they got.
 *
 * The admin "Steam profile lookup" tool consumes a stable object shape
 * (steamId64 / personaName / realName / avatarUrl / privacyState) rather than
 * raw XML, because it used to depend on the HTTP client happening to pre-parse
 * the response - which broke silently when the client changed.
 */

const FIELD_TAGS = ['steamID64', 'steamID', 'realname', 'avatarMedium', 'avatarFull', 'avatar', 'privacyState'];

function fromChildren(children) {
  const get = (name) => {
    const n = (children || []).find((c) => c && c.name === name);
    return n && n.value != null ? String(n.value) : '';
  };
  return {
    steamId64: get('steamID64'),
    personaName: get('steamID'),
    realName: get('realname'),
    avatarUrl: get('avatarMedium') || get('avatarFull') || get('avatar'),
    privacyState: get('privacyState'),
  };
}

function fromXml(xml) {
  const pick = (tag) => {
    const m = String(xml).match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
    return m ? m[1].trim() : '';
  };
  return {
    steamId64: pick('steamID64'),
    personaName: pick('steamID'),
    realName: pick('realname'),
    avatarUrl: pick('avatarMedium') || pick('avatarFull') || pick('avatar'),
    privacyState: pick('privacyState'),
  };
}

/**
 * @param {string|object} body raw XML string, or a parsed children array
 * @returns {{steamId64:string, personaName:string, realName:string, avatarUrl:string, privacyState:string}}
 */
function parseSteamProfile(body) {
  if (typeof body === 'string') return fromXml(body);
  if (body && Array.isArray(body.children)) return fromChildren(body.children);
  if (body && typeof body === 'object') return fromXml(JSON.stringify(body));
  return { steamId64: '', personaName: '', realName: '', avatarUrl: '', privacyState: '' };
}

/** Steam's <privacyState> is "public" for a profile we may read. */
function isPublicProfile(profile) {
  return String((profile && profile.privacyState) || '').toLowerCase() === 'public';
}

module.exports = { parseSteamProfile, isPublicProfile, FIELD_TAGS };
