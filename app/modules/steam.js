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

const STEAM_PROFILE_RE = /^https?:\/\/(www\.)?steamcommunity\.com\/(profiles\/\d{17}|id\/[A-Za-z0-9_-]{2,64})\/?$/;

class Steam {
  constructor() {

  }

  /**
   * Retrieve profile info from steam
   * @param {String} profileURL 
   */
  async getProfile(profileURL) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!profileURL) throw {
          type: "actor",
          desc: "URL not provided"
        }
        if (typeof profileURL !== 'string' || !STEAM_PROFILE_RE.test(profileURL.trim())) {
          throw { type: "actor", desc: "Invalid Steam profile URL" };
        }
        const finalURL = profileURL.trim().replace(/\/$/, '') + "?xml=1"
        needle('get', finalURL, { open_timeout: 8000, read_timeout: 8000, follow_max: 2 })
          .then(res => {
            resolve(res.body)
          })
          .catch(err => {
            return reject(err)
          });
      } catch (error) {
        logger.error("error in getProfile->", error);
        reject(error)
      }
    });
  }
}

module.exports = Steam;
