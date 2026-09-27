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

const initRazorpayPayment = (serverData, type) => {
  const gateway = "razorPay";
  custom_confirm(paymentForm(gateway), Mresponse => {
    let loader = `<div class="loading">Loading&#8230;</div>`;
    $("#divForLoader").html(loader);
    const userDetails = {
      userFirstName: cleanString($(`#${gateway}firstname`).val()),
      userEmail: $(`#${gateway}email`).val(),
      userMobile: $(`#${gateway}mobile`).val()
    };

    if (Object.values(userDetails).some(val => !val) || !Mresponse) {
      showNotif({ success: false, data: { error: "All fields are mandatory" } });
      $("#divForLoader").html("");
      return;
    }

    fetch("/initrazorpaypayment", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        serverData: { ...serverData, ...userDetails },
        type: type,
        apiCall: true
      })
    })
      .then(res => res.json())
      .then(response => {
        $("#divForLoader").html("");
        const {
          data: { res: orderData }
        } = response;
        startRzpPayment(orderData, type).then(res => res);
      })
      .catch(error => {
        $("#divForLoader").html("");
        showNotif({ success: false, data: { error: error } });
      });
  });
};

const startRzpPayment = async (orderData, type) => {
  if (!(orderData && orderData instanceof Object)) throw new TypeError("Invalid order data received!");

  const { id: orderId, amount_due, currency, notes, keyId, serverData } = orderData;

  const rzpPaymentOptions = {
    key: keyId,
    order_id: orderId,
    amount: amount_due,
    currency: currency,
    name: "",
    description: notes.productInfo,
    notes: notes,
    prefill: {
      name: serverData.userFirstName,
      email: serverData.userEmail,
      contact: serverData.userMobile
    },
    handler: response => {
      const responseObject = {
        order_id: response.razorpay_order_id,
        payer_id: response.razorpay_payment_id,
        payer_email: serverData.userEmail,
        payer_name: serverData.userFirstName,
        payer_surname: " ",
        product_desc: notes.productInfo,
        // amount_due is already in the currency's smallest sub-unit; convert
        // back with that currency's exponent rather than assuming 2 decimals.
        amount_paid: amount_due / Math.pow(10, (window.vmpCurrencyExponent ? window.vmpCurrencyExponent(currency) : 2)),
        amount_currency: currency,
        status: response.razorpay_payment_id && "success"
      };
      // Razorpay signs order_id|payment_id with the key secret and returns the
      // result as razorpay_payment_signature. The server verifies it (and then
      // confirms capture with Razorpay's API), so forward it untouched. The old
      // server code looked for a "razorpay_signature" field that never existed,
      // which rejected every real payment.
      responseObject.razorpay_payment_id = response.razorpay_payment_id;
      responseObject.razorpay_order_id = response.razorpay_order_id;
      responseObject.razorpay_payment_signature = response.razorpay_payment_signature;
      responseObject.razorpay_signature = response.razorpay_payment_signature;
      var giftR = (typeof vmpGetGiftFields === 'function') ? vmpGetGiftFields() : null;
      if (giftR === null) return;
      var payloadR = {
        serverData: serverData,
        paymentData: responseObject,
        buyType: type,
        gateway: "razorpay",
        razorpayData: response
      };
      if (giftR && giftR.isGift && (type === 'newPurchase' || type === 'newPurchaseBundle' || type === 'giftPurchase')) {
        payloadR.isGift = true;
        payloadR.recipientSteamId = giftR.recipientSteamId;
        if (type === 'newPurchase') payloadR.buyType = 'giftPurchase';
      }
      afterPaymentajax(payloadR);
    }
  };

  const rzpInst = new Razorpay(rzpPaymentOptions);
  rzpInst.on("payment.failed", response => {
    // A silent console.log used to be the whole handler: the buyer saw nothing
    // and retried blindly. Surface it, without dumping the raw response (it
    // can carry PII) into the console.
    var reason = response && response.error && response.error.description
      ? String(response.error.description).slice(0, 200)
      : 'Your payment was not completed. No money was taken — please try again.';
    if (typeof showNotif === 'function') showNotif({ success: false, data: { message: reason } });
    else if (window.vmpToast) window.vmpToast(reason, 'warning');
  });
  rzpInst.open();

  return true;
};
