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

function addNewAdminajax() {

  let loader = `<div class="loading">Loading&#8230;</div>`;
  $("#divForLoader").html(loader)

  let flagString = '"' + ($('#immunity_admin').val() / 1) + ':'
  let serverArray = []

  if (document.getElementById('admin_flag_manual_entry').checked) {
    if ($('#admin_group').val())
     flagString += ("@" + $('#admin_group').val())
  } else {
    $("input:checkbox[name=admin_flags]:checked").each(function () {
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
  }else if (serverArray.length == 0) {
    formError = "Select at least one server"
  }

  if (document.getElementById('admin_flag_manual_entry').checked) {
    if (!$('#admin_group').val()) {
      formError = "You selected to add Admin through admin group either provide a group name or use only flags"
    }
  } else {
    if (!flagString.split(":")[1]) {
      formError = "Select at least one flag"
    }
  }

  flagString += '"';

  if (formError == "") {
    fetch('/addadmin', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        "steamId": $('#steamId_add').val(),
        "name": $('#name_add').val(),
        "flag": flagString,
        "server": serverArray,
        "submit": "insert",
        "apiCall":true
      })
    })
      .then((res) => { return res.json(); })
      .then((response) => {
        $("#divForLoader").html("")
        showNotif(response)
        if (response.success == true) { getAdminTableListing(serverArray[0]) }
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

function deleteAdminajax(tableName, primaryKey) {

  let htmlString = `<p>Delete admin <code>${primaryKey}</code>?</p><p class="vmp-hint">This removes their access from the server immediately and refreshes the server config.</p>`

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
        .then((res) => {return res.json(); })
        .then((response) => {
          $("#divForLoader").html("")
          showNotif(response)
          if (response.success == true) {
            if ($("#hiddenServerTableName").val() && $('#adminSearchInput').val()) {
              getAdminTableListingSearch()
            } else {
              getAdminTableListing(tableName, $("#hiddenServerTableName").val().split(":")[1])
            }
          }
        })
        .catch(error => {
          $("#divForLoader").html("");
          showNotif({ success: false, data: { "error": error } })
        });
    }
  }, { title: 'Delete admin?', confirmLabel: 'Delete admin' })
}
//-----------------------------------------------------------------------------------------------------


//-----------------------------------------------------------------------------------------------------
// 


//-----------------------------------------------------------------------------------------------------
// Row template: mono IDs, copy button, labeled delete.

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function adminRowHtml(row) {
  const sid = row.authId ? row.authId.replace(/"/g, '') : '';
  const name = row.name ? row.name.replace("//", "") : 'NA';
  const flag = row.flag ? row.flag.replace(/"/g, '') : 'NA';
  return `<tr>
    <td><code translate="no">${escHtml(sid) || 'NA'}</code>${sid ? ` <button type="button" class="btn btn-default btn-fab" style="width:30px;height:30px;min-width:30px" data-copy="${escHtml(sid)}" aria-label="Copy Steam ID ${escHtml(sid)}"><i class="material-icons" aria-hidden="true" style="font-size:15px">content_copy</i></button>` : ''}</td>
    <td class="truncate" style="max-width:160px" title="${escHtml(name)}">${escHtml(name)}</td>
    <td><code translate="no">${escHtml(flag)}</code></td>
    <td>${escHtml(row.serverName ? row.serverName : 'NA')}</td>
    <td><button type="button" class="btn btn-danger btn-fab" style="width:38px;height:38px;min-width:38px" onclick="deleteAdminajax('${escHtml(row.server)}','${escHtml(sid)}')" aria-label="Delete admin ${escHtml(name)}"><i class="material-icons" aria-hidden="true">delete_forever</i></button></td>
  </tr>`;
}
//-----------------------------------------------------------------------------------------------------


function getAdminTableListing(value,name) {

  $("#dropdownMenuButton").text(name);
  $("#hiddenServerTableName").val(value + ":" + name);
  $("#manageCardTitle").text("View and Manage Admin of " + value.toUpperCase());

  if (value) {

    fetch('/getadmindatasingleserver', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        "server": value,
        "apiCall": true
      })
    })
      .then((res) => { return res.json(); })
      .then((response) => {
        let dataArray = response.data.res
        let htmlString = ""
        for (let i = 0; i < dataArray.length; i++) {
          htmlString += adminRowHtml(dataArray[i])
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

function getAdminTableListingSearch() {

  let loader = `<div class="loading">Loading&#8230;</div>`;
  $("#divForLoader").html(loader)

  let formError = ""
  if (!$('#adminSearchInput').val()) {
    formError = "Type something to search first."
  }

  if (formError == "") {
    fetch('/getadmindatasingleserver', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        "server": $("#hiddenServerTableName").val().split(":")[0],
        "serverName": $("#hiddenServerTableName").val().split(":")[1],
        "searchKey": $('#adminSearchInput').val(),
        "apiCall": true
      })
    })
      .then((res) => { return res.json(); })
      .then((response) => {
        $("#divForLoader").html("")
        let dataArray = response.data.res
        let htmlString = ""
        for (let i = 0; i < dataArray.length; i++) {
          htmlString += adminRowHtml(dataArray[i])
        }
        document.getElementById("manageVipTableBody").innerHTML = htmlString

        showNotif(response)
      })
      .catch(error => { showNotif({ success: false, data: { "error": error } }) });
  }
}
//-----------------------------------------------------------------------------------------------------


//-----------------------------------------------------------------------------------------------------
// Function to clear filters
function resetSearchAndTable() {
  $("#dropdownMenuButton").text("SELECT SERVER");
  $("#hiddenServerTableName").val("");
  $('#adminSearchInput').val("")
  document.getElementById("manageVipTableBody").innerHTML = ""
}
//-----------------------------------------------------------------------------------------------------


//-----------------------------------------------------------------------------------------------------
// 

$(document).ready(function () {

  document.getElementById('admin_flag_manual_entry').onchange = () => {

    let checkValue = document.getElementById('admin_flag_manual_entry').checked
    if (checkValue === true) {
      $("input[name='admin_flags']:checkbox").prop('checked', false);
    }
  };

  $("input[name='admin_flags']:checkbox").change(function () {
    $("input[name='admin_flag_manual_entry']:checkbox").prop('checked', false);
  });

  $(window).keydown(function (event) {
    if (event.keyCode == 13) {
      event.preventDefault();
      return false;
    }
  });
});