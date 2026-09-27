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
const logger = require('../modules/logger')('Steam Profile Data Fetch');
const Steam = require('../modules/steam');
const { parseSteamProfile, isPublicProfile } = require('../utils/steamProfileXml');

//-----------------------------------------------------------------------------------------------------
// 

exports.fetchProfileData = async (req, res) => {
  try {
    const steam = new Steam();
    const body = await steam.getProfile(req.body.profileUrl);
    // Parse here rather than shipping raw XML: the browser used to depend on
    // the HTTP client happening to hand back a pre-parsed object, so a change of
    // client silently produced a "Data fetched" toast with an empty form.
    const profile = parseSteamProfile(body);
    if (!profile.steamId64) {
      return res.json({
        success: false,
        data: { "error": 'Steam did not return a profile for that link. Check it is public and correct.' }
      });
    }
    // Only ever hand the browser an avatar URL we recognise as Steam's, so the
    // value is safe to drop into an <img src> without relying on the client.
    if (!/^https:\/\/avatars\.[a-z0-9.-]*steamstatic\.com\//i.test(profile.avatarUrl || '')) {
      profile.avatarUrl = '';
    }
    res.json({
      success: true,
      data: {
        "res": profile,
        "public": isPublicProfile(profile),
        "message": "Data fetched",
        "notifType": "success"
      }
    });
  } catch (error) {
    logger.error("Error fetching user data->", error);
    // Actor errors are user mistakes with safe, specific guidance — surface
    // them. Anything else (Steam unreachable, time-outs) gets a generic line.
    const friendly = (error && error.type === 'actor' && error.desc)
      ? String(error.desc)
      : 'Steam did not answer. Check the profile link and try again in a moment.';
    res.json({
      success: false,
      data: { "error": friendly }
    });
  }
};