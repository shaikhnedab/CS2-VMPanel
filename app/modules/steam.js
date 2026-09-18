/* VMP-by-Summer-Soldier
*
* Copyright (C) 2021 SUMMER SOLDIER - (SHIVAM PARASHAR)
*
* This file is part of VMP-by-Summer-Soldier
*
* VMP-by-Summer-Soldier is free software: you can redistribute it and/or modify it
* under the terms of the GNU General Public License as published by the Free
* Software Foundation, either version 3 of the License, or (at your option)
* any later version.
*
* VMP-by-Summer-Soldier is distributed in the hope that it will be useful, but WITHOUT
* ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
* FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License along with
* VMP-by-Summer-Soldier. If not, see http://www.gnu.org/licenses/.
*/

'use strict';
const needle = require('needle');
const logger = require('./logger')('Steam');

const STEAM_ID_RE = /^https?:\/\/(www\.)?steamcommunity\.com\/profiles\/(\d{17})\/?$/;
const STEAM_ID_BARE_RE = /^\d{17}$/;
const STEAM_VANITY_URL_RE = /^https?:\/\/(www\.)?steamcommunity\.com\/id\/([A-Za-z0-9_-]{2,64})\/?$/;
const STEAM_VANITY_RE = /^[A-Za-z0-9_-]{2,64}$/;

const FRIENDLY_INVALID_URL = 'That does not look like a Steam profile link. Paste the full URL, e.g. https://steamcommunity.com/profiles/7656119… or https://steamcommunity.com/id/name.';

class Steam {
  constructor() {

  }

  // Custom URL names (steamcommunity.com/id/<name>) resolve to a numeric id
  // via the Steam Web API. Throws an actor (user-facing) error when the key
  // is missing or Steam cannot resolve the name.
  async resolveVanity(vanity) {
    let apiKey = null;
    try {
      apiKey = require('../config').steam_api_key;
    } catch (e) { apiKey = null; }
    if (!apiKey) {
      throw {
        type: 'actor',
        desc: 'Custom profile names need a Steam API key on the panel. Paste the full numeric profile URL instead (steamcommunity.com/profiles/…).'
      };
    }
    let res;
    try {
      res = await needle('get',
        `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(apiKey)}&vanityurl=${encodeURIComponent(vanity)}`,
        { open_timeout: 8000, read_timeout: 8000 });
    } catch (e) {
      throw { type: 'actor', desc: 'Steam did not answer. Try again in a moment.' };
    }
    const r = res && res.body && res.body.response;
    if (!r || r.success !== 1 || !r.steamid) {
      throw { type: 'actor', desc: 'Steam could not find that profile name. Check the spelling or paste the full profile URL.' };
    }
    return r.steamid;
  }

  /**
   * Retrieve profile info from steam
   * @param {String} profileURL full profile URL or bare vanity name
   */
  async getProfile(profileURL) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!profileURL || typeof profileURL !== 'string' || !profileURL.trim()) {
          throw { type: 'actor', desc: 'Enter a Steam profile link first.' };
        }
        const input = profileURL.trim();
        let finalURL = null;
        const idMatch = input.match(STEAM_ID_RE);
        if (idMatch) {
          finalURL = `https://steamcommunity.com/profiles/${idMatch[2]}?xml=1`;
        } else if (STEAM_ID_BARE_RE.test(input)) {
          finalURL = `https://steamcommunity.com/profiles/${input}?xml=1`;
        } else if (STEAM_VANITY_URL_RE.test(input)) {
          // Steam resolves custom URLs itself on the xml endpoint — no API key needed.
          finalURL = `${input.replace(/\/$/, '')}?xml=1`;
        } else if (STEAM_VANITY_RE.test(input)) {
          const steamId = await this.resolveVanity(input);
          finalURL = `https://steamcommunity.com/profiles/${steamId}?xml=1`;
        } else {
          throw { type: 'actor', desc: FRIENDLY_INVALID_URL };
        }
        needle('get', finalURL, { open_timeout: 8000, read_timeout: 8000, follow_max: 2 })
          .then(res => {
            resolve(res.body);
          })
          .catch(err => {
            return reject(err);
          });
      } catch (error) {
        logger.error('error in getProfile->', error);
        reject(error);
      }
    });
  }
}

module.exports = Steam;
