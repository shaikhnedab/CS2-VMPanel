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
const logger = require('../modules/logger')('Sales Model');
var db = require('../db/db_bridge');
const config = require('../config');
const table = config.salestable

/**
 *   sales Model
 */
var salesModel = {

  /**
 * create table if not exists
 */
  createTheTableIfNotExists: function () {
    return new Promise(async (resolve, reject) => {
      try {

        // Matches migrations 001 (unique order_id, recipient_steamid, is_gift)
        // and 005 (grant_status, grant_error) so a fresh install that never
        // runs the migrator still gets the full schema. CREATE TABLE IF NOT
        // EXISTS never alters an existing table, so this is safe for upgrades.
        let query = db.queryFormat(`CREATE TABLE IF NOT EXISTS ${table} (
                                      id int(10) unsigned NOT NULL AUTO_INCREMENT,
                                      payment_gateway VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL,
                                      order_id varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
                                      payer_id varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
                                      payer_steamid varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
                                      recipient_steamid varchar(150) COLLATE utf8mb4_unicode_ci NULL,
                                      payer_email varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
                                      payer_name varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
                                      payer_surname varchar(150) COLLATE utf8mb4_unicode_ci NULL,
                                      product_desc varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
                                      amount_paid int(20) NOT NULL,
                                      amount_currency varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL,
                                      status varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
                                      sale_type tinyint(4) NOT NULL,
                                      is_gift tinyint(4) NOT NULL DEFAULT 0,
                                      grant_status varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
                                      grant_error varchar(255) COLLATE utf8mb4_unicode_ci NULL,
                                      created_on datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
                                      PRIMARY KEY (id),
                                      UNIQUE KEY ux_tbl_sales_order (order_id)
                                      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        let queryRes = await db.query(query, true);
        if (!queryRes) {
          return reject("Error in creating user table");
        }
        return resolve(true);
      } catch (error) {
        logger.error("error in createTheTableIfNotExists->", error);
        reject(error)
      }
    });
  },

  /**
   * get all the servers
   */
  insertNewSaleRecord: function (dataObj, gateway) {
    return new Promise(async (resolve, reject) => {
      try {

        // validation
        // Only the fields we cannot do without are mandatory. payer_name,
        // payer_surname and product_desc are descriptive: PayPal accounts with
        // no surname on file (and UPI/wallet flows with no email) used to be
        // rejected here, AFTER the money was captured, so the buyer paid and got
        // no VIP. Never make a descriptive field a hard requirement.
        if (!dataObj.order_id) return reject("Order Id Missing");
        if (!dataObj.payer_id) return reject("Payer Id Missing");
        if (!dataObj.payer_steamid) return reject("Payer Steam Id Missing");
        if (!dataObj.amount_paid) return reject("Amount Paid Missing");
        if (!dataObj.amount_currency) return reject("Amount Currency Missing");
        if (!dataObj.status) return reject("Payment Status Missing");
        if (!dataObj.sale_type) return reject("Sale Type Missing");

        const payerEmail = dataObj.payer_email || null;
        const payerName = dataObj.payer_name || null;
        const payerSurname = dataObj.payer_surname || null;
        const productDesc = dataObj.product_desc || null;

        let paymentGate = gateway === 'paypal' ? "PayPal" : gateway === 'payu' ? "PayU" : gateway === 'razorpay' ? "Razorpay" : "NA"
        let currentDateTime = new Date()

        const recipientSteamId = dataObj.recipient_steamid || null;
        const isGift = dataObj.is_gift ? 1 : 0;
        try {
          const query = db.queryFormat(`INSERT INTO ${table}
                                          (payment_gateway,
                                          order_id,
                                          payer_id,
                                          payer_steamid,
                                          recipient_steamid,
                                          payer_email,
                                          payer_name,
                                          payer_surname,
                                          product_desc,
                                          amount_paid,
                                          amount_currency,
                                          status,
                                          sale_type,
                                          is_gift,
                                          created_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [paymentGate, dataObj.order_id, dataObj.payer_id, dataObj.payer_steamid, recipientSteamId, payerEmail, payerName, payerSurname, productDesc, dataObj.amount_paid, dataObj.amount_currency, dataObj.status, dataObj.sale_type, isGift, currentDateTime]);
          const queryRes = await db.query(query);
          if (!queryRes) return reject("error in insertion");
          return resolve(true);
        } catch (e) {
          if (e && (e.code === 'ER_BAD_FIELD_ERROR' || /recipient_steamid|is_gift/.test((e && e.message) || ''))) {
            const fallback = db.queryFormat(`INSERT INTO ${table}
                                              (payment_gateway,
                                              order_id,
                                              payer_id,
                                              payer_steamid,
                                              payer_email,
                                              payer_name,
                                              payer_surname,
                                              product_desc,
                                              amount_paid,
                                              amount_currency,
                                              status,
                                              sale_type,
                                              created_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [paymentGate, dataObj.order_id, dataObj.payer_id, dataObj.payer_steamid, dataObj.payer_email, dataObj.payer_name, dataObj.payer_surname, dataObj.product_desc, dataObj.amount_paid, dataObj.amount_currency, dataObj.status, dataObj.sale_type, currentDateTime]);
            const queryRes = await db.query(fallback);
            if (!queryRes) return reject("error in insertion");
            return resolve(true);
          }
          throw e;
        }
      } catch (error) {
        logger.error("error in insertNewSaleRecord->", error);
        reject(error)
      }
    });
  },

  /**
   * Record whether the VIP was actually granted for a sale. Best-effort by
   * design: on a table that predates migration 005 the columns do not exist,
   * and tracking must never break settlement - so unknown-column errors
   * resolve (unmarked) instead of rejecting. The audit tool reports unmarked
   * rows as unknown rather than delivered.
   */
  setGrantStatus: function (orderId, status, error) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!orderId) return resolve(false);
        const safe = String(status) === 'granted' ? 'granted' : 'failed';
        const query = db.queryFormat(
          `UPDATE ${table} SET grant_status = ?, grant_error = ? WHERE order_id = ? LIMIT 1`,
          [safe, error ? String(error).slice(0, 255) : null, String(orderId)]);
        await db.query(query);
        return resolve(true);
      } catch (e) {
        if (e && (e.code === 'ER_BAD_FIELD_ERROR' || /grant_status|grant_error/.test((e && e.message) || ''))) {
          return resolve(false);
        }
        logger.error("error in setGrantStatus->", e);
        // A tracking write must never fail the settlement that called it.
        return resolve(false);
      }
    });
  },

  /**
   * Check whether an order_id was already processed (replay protection).
   */
  orderExists: function (orderId) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!orderId) return resolve(false);
        const query = db.queryFormat(`SELECT id FROM ${table} WHERE order_id = ? LIMIT 1`, [String(orderId)]);
        const queryRes = await db.query(query, true);
        return resolve(!!queryRes);
      } catch (error) {
        logger.error("error in orderExists->", error);
        reject(error)
      }
    });
  },

  /**
   * get all the sale data form the table
   */
  getAllSalesRecords: function (dataObj) {
    return new Promise(async (resolve, reject) => {
      try {
        const perPage = Math.min(Math.max(parseInt(dataObj.recordPerPage, 10) || 10, 1), 100);
        const page = Math.max(parseInt(dataObj.currentPage, 10) || 1, 1);
        const offset = (page - 1) * perPage;
        let query = db.queryFormat(`SELECT * FROM ${table} order by created_on DESC
                                    LIMIT ? OFFSET ?`, [perPage, offset]);
        let queryRes = await db.query(query);
        if (!queryRes) {
          return reject("No Data Found");
        }
        let queryData = queryRes

        query = db.queryFormat(`SELECT COUNT(id) as count FROM ${table}`);
        queryRes = await db.query(query, true);
        if (!queryRes) {
          return reject("No Data Found");
        }
        let totalRecords = queryRes.count
        return resolve({
          salesRecord: queryData,
          totalRecords: totalRecords
        });
      } catch (error) {
        logger.error("error in getAllSalesRecords->", error);
        reject(error)
      }
    });
  },

}

module.exports = salesModel;