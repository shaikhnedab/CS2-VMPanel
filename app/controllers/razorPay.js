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

"use strict";
const logger = require("../modules/logger")("RazorPay controller");
const SteamIDConverter = require("../utils/steamIdConvertor");
const config = require("../config");
const RazorPay = require("razorpay");
const { getUUID } = require("../utils/crypto");
const razorpayConfig = config.payment_gateways.razorPay;
const { resolveRowCurrency, normalizeCurrency, toMinorUnits } = require("../utils/currency");

exports.initRazorpayPayment = async (req, res) => {
  try {
    const result = await initRazorpayPaymentFunc(req.body, req.user);
    res.json({
      success: true,
      data: {
        res: result,
        message: "RazorPay initiated",
        notifType: "success"
      }
    });
  } catch (error) {
    logger.error("error in add/update vip->", error);
    res.json({
      success: false,
      data: { error: error }
    });
  }
};

const initRazorpayPaymentFunc = async (reqBody, reqUser) => {
  try {
    const steamId = SteamIDConverter.toSteamID(reqUser.id);
    return await createRzpOrder(reqBody, steamId);
  } catch (error) {
    logger.error("error in initRazorPayPaymentFunc->", error);
    throw JSON.stringify(error) + ", Please try again.";
  }
};

const createRzpOrder = async (reqBody, steamId) => {
  const { server_name, vip_price, vip_days } = reqBody.serverData;
  const productInfo = `${vip_days} days VIP for ${server_name} ${purchaseType(reqBody.type)}`;

  // Razorpay supports 160+ currencies on Payment Gateway / Checkout via
  // International Payments (settlement still lands as INR), and the docs are
  // explicit that a foreign currency is passed through as-is with the amount in
  // that currency's smallest sub-unit. It must NOT be forced to INR.
  const currency = await resolveRowCurrency(reqBody.serverData);
  if (!normalizeCurrency(currency)) {
    throw 'This server has no valid currency set, so the price cannot be charged. Please contact an admin.';
  }

  const rzpOrderOptions = {
    // Smallest sub-unit of the *chosen* currency: 2 for INR/USD, 0 for JPY,
    // 3 for KWD. A hardcoded *100 silently mischarges every non-2-decimal
    // currency by orders of magnitude.
    amount: toMinorUnits(vip_price, currency),
    receipt: createReceiptNumber(), // documented limit: 40 chars, must be unique
    notes: { steamId, productInfo }
  };

  let rzpInst = new RazorPay({ key_id: razorpayConfig.keyId, key_secret: razorpayConfig.keySecret });
  return {
    ...(await rzpInst.orders.create(rzpOrderOptions)),
    keyId: razorpayConfig.keyId,
    serverData: reqBody.serverData
  };
};

const purchaseType = type => {
  if (type == "newPurchase") return "(New Buy)";
  else if (type == "renewPurchase") return "(Renewal)";
  else return "";
};

const createReceiptNumber = () => {
  return `RZPRCPT-${getUUID(6)}`;
};
