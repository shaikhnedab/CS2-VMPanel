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

function addNewVIPajax() {

  let loader = `<div class="loading">Loading&#8230;</div>`;
  $("#divForLoader").html(loader)

  let flagString = '"' + ($('#immunity_vip').val() / 1) + ':'
  let serverArray = []

  if (document.getElementById('vip_flag_manual_entry').checked) {
    if ($('#vip_group').val())
     flagString += ("@" + $('#vip_group').val())
  } else {
    $("input:checkbox[name=vip_flags]:checked").each(function () {
      flagString += $(this).val();
    });
  }

  $("input:checkbox[name=server_add]:checked").each(function () {
    serverArray.push($(this).val());
  });

  let formError = ""
  if (!$('#steamId_add').val()) {
    formError = "Steam ID is required"
  } else if (!$('#name_add').val()) {
    formError = "Name is required"
  } else if (!$('#day_add').val()) {
    formError = "Enter the number of days"
  } else if (serverArray.length == 0) {
    formError = "Select at least one server"
  }

  if (document.getElementById('vip_flag_manual_entry').checked) {
    if (!$('#vip_group').val()) {
      formError = "You selected to add VIP through admin group either provide a group name or use only flags"
    }
  } else {
    if (!flagString.split(":")[1]) {
      formError = "Select at least one flag"
    }
  }

  flagString += '"';

  if (formError == "") {
    fetch('/addvip', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        "steamId": $('#steamId_add').val(),
        "name": $('#name_add').val(),
        "day": $('#day_add').val(),
        "flag": flagString,
        "server": serverArray,
        "submit": "insert",
        "apiCall": true
      })
    })
      .then((res) => { return res.json(); })
      .then((response) => {
        $("#divForLoader").html("")
        showNotif(response)
        if (response.success == true) { getVIPTableListing(serverArray[0]) }
      })
      .catch(error => {
        $("#divForLoader").html("")
        showNotif({ success: false, data: { "error": error } })
      });
  } else {
    $("#divForLoader").html("")
    showNotif({ success: false, data: { "error": formError } })
  }
}
//-----------------------------------------------------------------------------------------------------


//-----------------------------------------------------------------------------------------------------
// 

function updateOldVIPajax() {

  let loader = `<div class="loading">Loading&#8230;</div>`;
  $("#divForLoader").html(loader)

  let serverArray = []
  $("input:checkbox[name=server_update]:checked").each(function () {
    serverArray.push($(this).val());
  });

  let formError = ""
  if (!$('#steamId_update').val()) {
    formError = "Steam ID is required"
  } else if (!$('#day_update').val()) {
    formError = "Enter the number of days"
  } else if (serverArray.length == 0) {
    formError = "Select at least one server"
  }

  if (formError == "") {
    fetch('/addvip', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        "steamId": $('#steamId_update').val(),
        "day": $('#day_update').val(),
        "server": serverArray,
        "submit": "update",
        "apiCall": true
      })
    })
      .then((res) => { return res.json(); })
      .then((response) => {
        $("#divForLoader").html("")
        showNotif(response)
        if (response.success == true) { getVIPTableListing(serverArray[0]) }
      })
      .catch(error => {
        $("#divForLoader").html("")
        showNotif({ success: false, data: { "error": error } })
      });
  } else {
    $("#divForLoader").html("")
    showNotif({ success: false, data: { "error": formError } })
  }
}
//-----------------------------------------------------------------------------------------------------


//-----------------------------------------------------------------------------------------------------
// 

function deleteVIPajax(tableName, primaryKey) {

  let htmlString = `<p>Delete VIP <code>${primaryKey}</code>?</p><p class="vmp-hint">This removes their access from the server immediately and refreshes the server config.</p>`

  custom_confirm(htmlString, (Mresponse) => {
    if (Mresponse == true) {
      let loader = `<div class="loading">Loading&#8230;</div>`;
      $("#divForLoader").html(loader)

      fetch('/deletevip', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          "tableName": tableName,
          "primaryKey": primaryKey,
          "apiCall": true
        })
      })
        .then((res) => { return res.json(); })
        .then((response) => {
          $("#divForLoader").html("")
          showNotif(response)
          if (response.success == true) {
            if ($("#hiddenServerTableName").val() && $('#vipSearchInput').val()) {
              getVIPTableListingSearch()
            } else {
              getVIPTableListing(tableName, $("#hiddenServerTableName").val().split(":")[1])
            }
          }
        })
        .catch(error => {
          $("#divForLoader").html("")
          showNotif({ success: false, data: { "error": error } })
        });
    }
  }, { title: 'Delete VIP?', confirmLabel: 'Delete VIP' })
}
//-----------------------------------------------------------------------------------------------------


//-----------------------------------------------------------------------------------------------------
// 


//-----------------------------------------------------------------------------------------------------
// Row template: mono IDs, copy button, expiry badge, labeled delete.

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function expiryBadge(days) {
  days = days / 1;
  if (days < 5) return `<span class="vmp-badge bad"><span class="vmp-dot pulse"></span>${days} days left</span>`;
  if (days < 10) return `<span class="vmp-badge warn"><span class="vmp-dot"></span>${days} days left</span>`;
  return `<span class="vmp-badge ok"><span class="vmp-dot"></span>${days} days left</span>`;
}

function vipRowHtml(row) {
  const sid = row.authId ? row.authId.replace(/"/g, '') : '';
  const name = row.name ? row.name.replace("//", "") : 'NA';
  const flag = row.flag ? row.flag.replace(/"/g, '') : 'NA';
  return `<tr>
    <td><code translate="no">${escHtml(sid) || 'NA'}</code>${sid ? ` <button type="button" class="btn btn-default btn-fab" style="width:30px;height:30px;min-width:30px" data-copy="${escHtml(sid)}" aria-label="Copy Steam ID ${escHtml(sid)}"><i class="material-icons" aria-hidden="true" style="font-size:15px">content_copy</i></button>` : ''}</td>
    <td class="truncate" style="max-width:160px" title="${escHtml(name)}">${escHtml(name)}</td>
    <td><code translate="no">${escHtml(flag)}</code></td>
    <td>${escHtml(row.serverName ? row.serverName : 'NA')}</td>
    <td class="mono tnum">${row.created_at ? dateFormatter(row.created_at) : 'NA'}</td>
    <td class="mono tnum">${row.expireStamp ? EpocToDate(row.expireStamp) : 'NA'}</td>
    <td>${row.expireStamp ? expiryBadge(remainingDays(row.expireStamp)) : 'NA'}</td>
    <td><button type="button" class="btn btn-danger btn-fab" style="width:38px;height:38px;min-width:38px" onclick="deleteVIPajax('${escHtml(row.server)}','${escHtml(sid)}')" aria-label="Delete VIP ${escHtml(name)}"><i class="material-icons" aria-hidden="true">delete_forever</i></button></td>
  </tr>`;
}
//-----------------------------------------------------------------------------------------------------


function getVIPTableListing(value, name) {
  if (value) {

    $("#dropdownMenuButton").text(name);
    $("#hiddenServerTableName").val(value + ":" + name);
    $("#manageCardTitle").text("View and Manage VIP of " + (name ? name : value.toUpperCase()));

    fetch('/getvipdatasingleserver', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        "server": value,
        "serverName": name,
        "apiCall": true
      })
    })
      .then((res) => { return res.json(); })
      .then((response) => {
        let dataArray = response.data.res
        let htmlString = ""
        for (let i = 0; i < dataArray.length; i++) {
          htmlString += vipRowHtml(dataArray[i])
        }
        document.getElementById("manageVipTableBody").innerHTML = htmlString

        showNotif(response)
      })
      .catch(error => { showNotif({ success: false, data: { "error": error } }) });
  }
}
//-----------------------------------------------------------------------------------------------------


//-----------------------------------------------------------------------------------------------------
// 

function getVIPTableListingSearch() {

  let loader = `<div class="loading">Loading&#8230;</div>`;
  $("#divForLoader").html(loader)

  let formError = ""
  if (!$('#vipSearchInput').val()) {
    formError = "Type something to search first."
  }

  if (formError == "") {
    fetch('/getvipdatasingleserver', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        "server": $("#hiddenServerTableName").val().split(":")[0],
        "serverName": $("#hiddenServerTableName").val().split(":")[1],
        "searchKey": $('#vipSearchInput').val(),
        "apiCall": true
      })
    })
      .then((res) => { return res.json(); })
      .then((response) => {
        $("#divForLoader").html("")
        let dataArray = response.data.res
        let htmlString = ""
        for (let i = 0; i < dataArray.length; i++) {
          htmlString += vipRowHtml(dataArray[i])
        }
        document.getElementById("manageVipTableBody").innerHTML = htmlString

        showNotif(response)
      })
      .catch(error => { showNotif({ success: false, data: { "error": error } }) });

  } else {
    $("#divForLoader").html("")
    showNotif({ success: false, data: { "error": formError } })
  }
}
//-----------------------------------------------------------------------------------------------------


//-----------------------------------------------------------------------------------------------------
// Function to clear filters
function resetSearchAndTable() {
  $("#dropdownMenuButton").text("SELECT SERVER");
  $("#hiddenServerTableName").val("");
  $('#vipSearchInput').val("")
  document.getElementById("manageVipTableBody").innerHTML = ""
}
//-----------------------------------------------------------------------------------------------------


//-----------------------------------------------------------------------------------------------------
// 

function EpocToDate(utcSeconds) {
  let d = new Date(0);
  d.setUTCSeconds(utcSeconds)
  let dd = d.getDate();
  let mm = d.getMonth() + 1;
  let yyyy = d.getFullYear();
  return dd + '-' + mm + '-' + yyyy;
}

function dateFormatter(date) {
  let d = new Date(date);
  let dd = d.getDate();
  let mm = d.getMonth() + 1;
  let yyyy = d.getFullYear();
  return dd + '-' + mm + '-' + yyyy;
}

function remainingDays(endEpoc) {
  const date1 = new Date();
  const date2 = new Date(0);
  date2.setUTCSeconds(endEpoc)
  const diffTime = Math.abs(date2 - date1);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays
}

$(document).ready(function () {

  document.getElementById('vip_flag_manual_entry').onchange = () => {

    let checkValue = document.getElementById('vip_flag_manual_entry').checked
    if (checkValue === true) {
      $("input[name='vip_flags']:checkbox").prop('checked', false);
      let ipHtml = `<label class="">Enter group name</label>
                    <input id="vip_group" type="text" class="form-control" value="" required>`
      $("#vip-group-div").html(ipHtml)
    } else {
      $("#vip-group-div").html("")
    }
  };

  $("input[name='vip_flags']:checkbox").change(function () {
    $("input[name='vip_flag_manual_entry']:checkbox").prop('checked', false);
  });

  $(window).keydown(function (event) {
    if (event.keyCode == 13) {
      event.preventDefault();
      return false;
    }
  });
});