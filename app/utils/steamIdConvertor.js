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


const bigInt = require("big-integer");

var SteamIDConverter = {

  BASE_NUM: bigInt("76561197960265728"), // "V" in the conversion algorithms

  REGEX_STEAMID64: /^[0-9]{17}$/,
  REGEX_STEAMID: /^STEAM_[0-5]:[01]:\d+$/,
  REGEX_STEAMID3: /^\[U:1:[0-9]+\]$/,

  /**
   * Generate a SteamID64 from a SteamID or SteamID3
   */
  toSteamID64: function (steamid) {
    if (!steamid || typeof steamid !== "string") {
      return false;
    }
    else if (this.isSteamID3(steamid)) {
      steamid = this.fromSteamID3(steamid);
    }
    else if (!this.isSteamID(steamid)) {
      throw new TypeError("Parameter must be a SteamID (e.g. STEAM_0:1:912783)");
    }

    var split = steamid.split(":"),
      v = this.BASE_NUM,
      z = split[2],
      y = split[1];

    if (z && y) {
      return v.plus(z * 2).plus(y).toString();
    }
    return false;
  },

  /**
   * Generate a SteamID from a SteamID64 or SteamID3
   */
  toSteamID: function (steamid64) {
    if (!steamid64 || typeof steamid64 !== "string") {
      return false;
    }
    else if (this.isSteamID3(steamid64)) {
      return this.fromSteamID3(steamid64);
    }
    else if (!this.isSteamID64(steamid64)) {
      throw new TypeError("Parameter must be a SteamID64 (e.g. 76561190000000000)");
    }

    var v = this.BASE_NUM,
      w = bigInt(steamid64),
      y = w.mod(2).toString();

    w = w.minus(y).minus(v);

    if (w < 1) {
      return false;
    }
    return "STEAM_1:" + y + ":" + w.divide(2).toString();
  },

  /**
   * Generate a SteamID3 from a SteamID or SteamID64
   */
  toSteamID3: function (steamid) {
    if (!steamid || typeof steamid !== "string") {
      return false;
    }
    else if (!this.isSteamID(steamid)) {
      steamid = this.toSteamID(steamid);
    }

    var split = steamid.split(":");

    return "[U:1:" + (parseInt(split[1]) + parseInt(split[2]) * 2) + "]";
  },

  /**
   * Generate a SteamID from a SteamID3.
   */
  fromSteamID3: function (steamid3) {
    var split = steamid3.split(":");
    var last = split[2].substring(0, split[2].length - 1);

    return "STEAM_0:" + (last % 2) + ":" + Math.floor(last / 2);
  },

  // ------------------------------------------------------------------------------

  isSteamID: function (id) {
    if (!id || typeof id !== "string") {
      return false;
    }
    return this.REGEX_STEAMID.test(id);
  },

  isSteamID64: function (id) {
    if (!id || typeof id !== "string") {
      return false;
    }
    return this.REGEX_STEAMID64.test(id);
  },

  isSteamID3: function (id) {
    if (!id || typeof id !== "string") {
      return false;
    }
    return this.REGEX_STEAMID3.test(id);
  },

  // ------------------------------------------------------------------------------

  /**
   * Canonical 64-bit ID from any accepted form: 17-digit ID, STEAM_X:Y:Z
   * (STEAM_0: is canonicalized to STEAM_1: first — the Y bit changes the
   * result), [U:1:N], optionally wrapped in quotes or whitespace.
   * Throws TypeError with a user-facing message when unusable.
   */
  toCanonical64: function (input) {
    const s = String(input === undefined || input === null ? '' : input).trim().replace(/^"+|"+$/g, '').trim();
    if (!s) throw new TypeError('Enter a Steam ID first.');
    if (this.isSteamID64(s)) return s;
    const canon = s.replace(/^STEAM_0:/, 'STEAM_1:');
    if (this.isSteamID(canon)) return this.toSteamID64(canon);
    if (this.isSteamID3(s)) return this.toSteamID64(this.fromSteamID3(s));
    throw new TypeError('That does not look like a Steam ID. Use STEAM_1:0:123456, [U:1:123456], or 7656119…');
  },

  /**
   * Quoted authId variants for DB matching: [quoted 64-bit, quoted legacy
   * STEAM_]. Writers store [0]; readers match IN (both) so legacy rows keep
   * working. Values carry the literal quotes the authId column convention
   * uses — pass straight into query placeholders.
   */
  quotedAuthIdVariants: function (input) {
    const id64 = this.toCanonical64(input);
    return [`"${id64}"`, `"${this.toSteamID(id64)}"`];
  },

  // ------------------------------------------------------------------------------

  profileURL: function (steamid64) {
    if (!this.isSteamID64(steamid64)) {
      steamid64 = this.toSteamID64(steamid64);
    }
    return "http://steamcommunity.com/profiles/" + steamid64;
  }
};


module.exports = SteamIDConverter;