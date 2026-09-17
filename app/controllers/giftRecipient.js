'use strict';
// Resolves a gift receiver from a Steam profile link or raw SteamID into
// server-verified identifiers + display profile (name/avatar).
// Only the verified canonical IDs are ever used downstream.

const logger = require('../modules/logger')('Gift Recipient');
const Steam = require('../modules/steam');
const SteamIDConverter = require('../utils/steamIdConvertor');
const { sendSafeError } = require('../utils/safeError');

const PROFILE_URL_RE = /^https?:\/\/(www\.)?steamcommunity\.com\/(profiles\/\d{17}|id\/[A-Za-z0-9_-]{2,64})\/?(\?.*)?$/i;
const VANITY_RE = /^https?:\/\/(www\.)?steamcommunity\.com\/id\/([A-Za-z0-9_-]{2,64})\/?(\?.*)?$/i;
const ID64_RE = /^[0-9]{17}$/;

function escOut(s) {
  return String(s == null ? '' : s).slice(0, 160);
}

// Pull the fields we need out of a Steam ?xml=1 payload, whether needle
// handed us a raw string or a pre-parsed object with a children array.
function parseProfileXml(body) {
  let xml = null;
  if (typeof body === 'string') {
    xml = body;
  } else if (body && Array.isArray(body.children)) {
    const get = (name) => {
      const n = body.children.find((c) => c && c.name === name);
      return n && n.value != null ? String(n.value) : '';
    };
    return {
      steamId64: get('steamID64'),
      personaName: get('steamID'),
      avatarUrl: get('avatarMedium') || get('avatarFull') || get('avatar'),
      privacy: get('privacyState'),
    };
  } else if (body && typeof body === 'object') {
    xml = JSON.stringify(body);
  }
  if (!xml) return { steamId64: '', personaName: '', avatarUrl: '', privacy: '' };
  const pick = (tag) => {
    const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
    return m ? m[1].trim() : '';
  };
  return {
    steamId64: pick('steamID64'),
    personaName: pick('steamID'),
    avatarUrl: pick('avatarMedium') || pick('avatarFull') || pick('avatar'),
    privacy: pick('privacyState'),
  };
}

function normalizeInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter a Steam profile link or Steam ID first.');
  const canon = (sid) => String(sid).replace(/^STEAM_0:/, 'STEAM_1:');
  if (SteamIDConverter.isSteamID(raw)) {
    const sid = canon(raw);
    return { kind: 'id', steamId: sid, profileUrl: `https://steamcommunity.com/profiles/${SteamIDConverter.toSteamID64(sid)}` };
  }
  if (SteamIDConverter.isSteamID64(raw)) {
    return { kind: 'id64', steamId64: raw, profileUrl: `https://steamcommunity.com/profiles/${raw}` };
  }
  if (SteamIDConverter.isSteamID3(raw)) {
    const sid = canon(SteamIDConverter.fromSteamID3(raw));
    return { kind: 'id', steamId: sid, profileUrl: `https://steamcommunity.com/profiles/${SteamIDConverter.toSteamID64(sid)}` };
  }
  const m = raw.match(PROFILE_URL_RE);
  if (m) return { kind: 'url', profileUrl: `https://steamcommunity.com/${raw.match(VANITY_RE) ? `id/${raw.match(VANITY_RE)[2]}` : `profiles/${raw.match(/profiles\/(\d{17})/i)[1]}`}` };
  throw new Error('That does not look like a valid Steam profile link or Steam ID.');
}

const resolveRecipientFunc = async (input) => {
  const norm = normalizeInput(input);
  const steam = new Steam();
  const body = await steam.getProfile(norm.profileUrl);
  const prof = parseProfileXml(body);
  if (!prof.steamId64 || !ID64_RE.test(prof.steamId64)) {
    throw new Error('Steam did not return a profile for that link. Check it is public and correct.');
  }
  const steamId = SteamIDConverter.toSteamID(prof.steamId64);
  if (!steamId) throw new Error('Could not resolve a Steam ID from that profile.');
  return {
    steamId64: prof.steamId64,
    steamId,
    personaName: escOut(prof.personaName) || 'Steam user',
    avatarUrl: /^https:\/\/avatars\.[a-z0-9.-]*steamstatic\.com\//i.test(prof.avatarUrl) ? prof.avatarUrl : '',
  };
};

exports.resolveRecipient = async (req, res) => {
  try {
    const result = await resolveRecipientFunc(req.body && req.body.input);
    res.json({ success: true, data: { res: result, message: 'Receiver verified', notifType: 'success' } });
  } catch (error) {
    logger.error('error in resolveRecipient->', error);
    return sendSafeError(req, res, error, 'Could not verify that Steam profile. Check the link and try again.');
  }
};

exports.resolveRecipientFunc = resolveRecipientFunc;
exports.normalizeInput = normalizeInput;
exports.parseProfileXml = parseProfileXml;
