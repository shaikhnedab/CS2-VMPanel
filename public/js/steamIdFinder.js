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

//-----------------------------------------------------------------------------------------------------
// 

// vmp-ui.js normally provides this, but this file is also loaded on its own in
// a couple of views - fall back rather than throw while building the avatar tag.
if (typeof escHtml !== 'function') {
  window.escHtml = window.escHtml || function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
}

function profileUrlToDataFetcher(profileUrl) {

  if (profileUrl) {

    let loader = `<div class="loading">Loading&#8230;</div>`;
    $("#divForLoader").html(loader)

    fetch('/fetchsteamprofiledata', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        "profileUrl": profileUrl,
        "apiCall": true
      })
    })
      .then((res) => { return res.json(); })
      .then((response) => {
        try {
          // Backend failure (bad URL, Steam unreachable) carries success:false
          // with a friendly message. On success the server has already parsed
          // the Steam XML into named fields.
          if (!response || response.success !== true || !response.data || !response.data.res) {
            throw new Error((response && response.data && (response.data.error || response.data.message)) || 'Could not fetch Steam profile data.');
          }
          const prof = response.data.res;
          const privacyState = prof.privacyState || '';
          const steamID64 = prof.steamId64 || '';
          const userName = cleanString(prof.personaName || '');
          const realName = cleanString(prof.realName || '');
          const dpURL = prof.avatarUrl || '';

          $("#divForLoader").html("")

          if (privacyState && privacyState.toLowerCase() !== 'public') {
            showNotif({
              success: false,
              data: { "error": "Can not fetch user data Profile privacy is " + privacyState }
            })
            return;
          }
          if (!steamID64) {
            showNotif({ success: false, data: { "error": 'Steam did not return a SteamID for that profile.' } })
            return;
          }

          let finalName = realName + " - (" + (userName ? userName : "-_-") + ")"
          // Forms take the 64-bit ID (what the game plugin expects); the
          // server canonicalizes any format on submit regardless.
          let finalSteamID = steamID64;

          $('#steamId_add').val(finalSteamID);
          $('#name_add').val(finalName);
          $('#name_comm').val(finalName);
          $('#steamId_update').val(finalSteamID);
          $("#display_steamId").text(finalSteamID)
          $("#display_name").text(userName)
          // The server already restricts this to Steam CDN hosts; require https
          // here too so a crafted scheme can never become a script sink.
          if (dpURL && /^https:\/\//i.test(dpURL)) {
            $("#dp_div").html('<img src="' + escHtml(dpURL) + '" alt="Profile Picture">');
          } else {
            $("#dp_div").html('');
          }
          $("#name_add").focus();
        } catch (e) {
          $("#divForLoader").html("")
          showNotif({
            success: false,
            data: { "error": (e && e.message) || 'Could not fetch Steam profile data.' }
          })
        }
      })
      .catch(error => {
        showNotif({ success: false, data: { "error": error } })
      });
  } else {
    showNotif({
      success: false,
      data: { "error": "Profile Url is Missing" }
    })
  }
}
//-----------------------------------------------------------------------------------------------------

function cleanString(input) {
  var output = "";
  for (var i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) <= 127) {
      output += input.charAt(i);
    }
  }
  return output;
}