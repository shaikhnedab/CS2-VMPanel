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

//-----------------------------------------------------------------------------------------------------
// VIP gifting with verified receiver. The buyer pastes a profile link (or raw
// ID), clicks Verify, and checkout only proceeds with the server-verified
// canonical SteamID shown in the receiver preview.

window.vmpGift = window.vmpGift || { isGift: false, recipientSteamId: '', verifiedFor: '' };

function vmpGiftInputChanged() {
  // Any edit invalidates the previous verification.
  window.vmpGift.verifiedFor = '';
  window.vmpGift.recipientSteamId = '';
  var prev = document.getElementById('vmpGiftReceiverPreview');
  if (prev) { prev.style.display = 'none'; prev.innerHTML = ''; }
}

function vmpVerifyGiftRecipient() {
  var input = document.getElementById('vmpGiftRecipient');
  var raw = input ? String(input.value || '').trim() : '';
  if (!raw) {
    showNotif({ success: false, data: { message: 'Paste the receiver\'s Steam profile link or Steam ID first.' } });
    return;
  }
  var btn = document.getElementById('vmpGiftVerifyBtn');
  if (window.vmpLoading) window.vmpLoading(btn, true, 'Verifying…');
  else if (btn) btn.disabled = true;
  fetch('/resolverecipient', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: raw })
  })
    .then(function (res) { return res.json(); })
    .then(function (response) {
      if (window.vmpLoading) window.vmpLoading(btn, false);
      else if (btn) btn.disabled = false;
      if (!response || !response.success || !response.data || !response.data.res) {
        var msg = (response && response.data && response.data.message) || 'Could not verify that profile.';
        showNotif({ success: false, data: { message: msg } });
        return;
      }
      var r = response.data.res;
      var rid64 = r.steamId64 || r.steamId;
      window.vmpGift.recipientSteamId = rid64;
      window.vmpGift.verifiedFor = raw;
      var prev = document.getElementById('vmpGiftReceiverPreview');
      if (prev) {
        var avatar = r.avatarUrl
          ? '<img src="' + escHtml(r.avatarUrl) + '" alt="Receiver avatar" width="52" height="52" loading="lazy" style="border-radius:14px">'
          : '<div class="vmp-stat-icon blue" aria-hidden="true"><i class="material-icons">person</i></div>';
        prev.innerHTML = '<div class="card" style="margin:0"><div class="card-body" style="display:flex;gap:14px;align-items:center;padding:14px 16px !important">'
          + avatar
          + '<div style="min-width:0"><p class="eyebrow">Verified receiver</p>'
          + '<h4 class="card-title truncate" style="margin:0" title="' + escHtml(r.personaName) + '">' + escHtml(r.personaName) + '</h4>'
          + '<code class="mono" translate="no">' + escHtml(rid64) + '</code></div>'
          + '<span class="vmp-badge ok" style="margin-left:auto"><span class="vmp-dot" aria-hidden="true"></span>Verified</span>'
          + '</div></div>';
        prev.style.display = '';
      }
      showNotif({ success: true, data: { message: 'Receiver verified: ' + r.personaName, notifType: 'success' } });
    })
    .catch(function (error) {
      if (window.vmpLoading) window.vmpLoading(btn, false);
      else if (btn) btn.disabled = false;
      showNotif({ success: false, data: { error: error } });
    });
}

function vmpGetGiftFields() {
  try {
    var toggle = document.getElementById('vmpGiftToggle');
    var input = document.getElementById('vmpGiftRecipient');
    var isGift = !!(toggle && toggle.checked);
    if (!isGift) return { isGift: false };
    var raw = input ? String(input.value || '').trim() : '';
    if (!raw) {
      showNotif({ success: false, data: { message: 'Paste the receiver\'s Steam profile link first.' } });
      return null;
    }
    if (!window.vmpGift.recipientSteamId || window.vmpGift.verifiedFor !== raw) {
      showNotif({ success: false, data: { message: 'Click "Verify receiver" first so the panel confirms who gets the VIP.' } });
      return null;
    }
    return { isGift: true, recipientSteamId: window.vmpGift.recipientSteamId, buyType: 'giftPurchase' };
  } catch (e) { return { isGift: false }; }
}

function vmpToggleGiftUI() {
  var wrap = document.getElementById('vmpGiftRecipientWrap');
  var toggle = document.getElementById('vmpGiftToggle');
  if (wrap) wrap.style.display = (toggle && toggle.checked) ? '' : 'none';
  if (!toggle || !toggle.checked) vmpGiftInputChanged();
}
//-----------------------------------------------------------------------------------------------------

function afterPaymentajax(formData) {

  fetch('/execafterpaymentprocess', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(formData)
  })
    .then((res) => { return res.json(); })
    .then((response) => {
      $("#divForLoader").html("")
      showNotif(response)
      setTimeout(function () {
        document.location.reload()
      }, 5000);
    })
    .catch(error => {
      $("#divForLoader").html("")
      showNotif({ success: false, data: { "error": error } })
    });
}
//-----------------------------------------------------------------------------------------------------


//-----------------------------------------------------------------------------------------------------
// 
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function slotId(prefix, name, i) {
  return ((name ? String(name).replace(/[^A-Za-z0-9_]/g, '') : '') || ('slot' + i)) + prefix;
}

function fetchPBundleListajax() {

  fetch('/getpanelbundleslistud', {
    method: 'get',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  })
    .then((res) => { return res.json(); })
    .then((response) => {
      if (response.success == true) {

        let dataArray = response.data.res

        let htmlString = "";

        for (let i = 0; i < dataArray.length; i++) {

          let serversHtml = '', serversTblNames = []
          for (let j = 0; j < dataArray[i].bundleServersData.length; j++) {
            serversHtml += `<a class="vmp-badge violet" href="steam://connect/${escHtml(dataArray[i].bundleServersData[j].server_ip + ':' + dataArray[i].bundleServersData[j].server_port)}">${escHtml(dataArray[i].bundleServersData[j].server_name)}</a>`
            serversTblNames.push(dataArray[i].bundleServersData[j].tbl_name)
          }

          let serverDataObj = {
            "id": dataArray[i].id,
            "server_ip": "-",
            "server_port": "-",
            "server_name": dataArray[i].bundle_name,
            "vip_price": dataArray[i].bundle_price,
            "vip_currency": dataArray[i].bundle_currency,
            "vip_days": dataArray[i].bundle_sub_days,
            "tbl_name": serversTblNames.join(','),
            "vip_flag": dataArray[i].bundle_flags
          }

          let payload = encodeURIComponent(JSON.stringify(serverDataObj))
          let slot = slotId('dynbundlebuy', dataArray[i].bundle_name, i);
          let altPay = '';
          if (typeof payuActive !== 'undefined' && payuActive) {
            altPay += `<button type="button" class="btn btn-success btn-block" data-checkout data-gateway="payu" data-payload="${payload}" data-buytype="newPurchaseBundle" aria-label="Buy bundle with PayU"><img src="./images/payumoney.png" height="20" width="76" alt="PayU"></button>`;
          }
          if (typeof razorpayActive !== 'undefined' && razorpayActive) {
            altPay += `<button type="button" class="btn btn-success btn-block" data-checkout data-gateway="razorpay" data-payload="${payload}" data-buytype="newPurchaseBundle" aria-label="Buy bundle with Razorpay"><img src="./images/razorpay.svg" height="20" width="76" alt="Razorpay"></button>`;
          }

          htmlString += `<div class="col-xl-4 col-lg-6 col-md-6 col-sm-12">
                          <div class="card vmp-product">
                            <div class="card-body">
                              <p class="eyebrow">Bundle · ${escHtml(dataArray[i].bundle_sub_days)} days each</p>
                              <h4 class="card-title truncate" title="${escHtml(dataArray[i].bundle_name)}">${escHtml(dataArray[i].bundle_name)}</h4>
                              <div class="vmp-price tnum">${escHtml(dataArray[i].bundle_price + " " + dataArray[i].bundle_currency)}</div>
                              <div class="vmp-perks">${serversHtml}</div>
                            </div>
                            <div class="card-footer">
                              <div class="vmp-paypal-slot" id="${slot}" data-payload="${payload}" data-buytype="newPurchaseBundle"></div>
                              ${altPay}
                            </div>
                          </div>
                        </div>`

        }

        document.getElementById("userDashoardServerBundleListing").innerHTML = htmlString
        document.querySelectorAll('#userDashoardServerBundleListing .vmp-paypal-slot').forEach(function (el) {
          if (typeof vmpInitPayPalSlot === 'function') vmpInitPayPalSlot(el);
        });
      }
    })
    .catch(error => {
      showNotif({ success: false, data: { "error": error } })
    });
}
//-----------------------------------------------------------------------------------------------------

$(document).ready(function () {

  // fetchPBundleListajax();
});