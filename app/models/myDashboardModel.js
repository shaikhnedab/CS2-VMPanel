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
const logger = require('../modules/logger')('My Dashboard Model');

const TABLE_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

var db = require('../db/db_bridge');
const panelServerModal = require("./panelServerModal.js");
const SteamIDConverter = require("../utils/steamIdConvertor");
const config = require('../config');
const salestable = config.salestable
const serverTable = config.serverTable


/**
 *   myDashboardModel Model
 */
var myDashboardModel = {

  /**
   * get User Data From All Servers
   */
  getUserDataFromAllServers: function (steamId) {
    return new Promise(async (resolve, reject) => {
      try {
        const serverList = await panelServerModal.getPanelServersDisplayList();

        // Match every stored spelling (quoted/bare × 64-bit/legacy STEAM_).
        const matchIds = SteamIDConverter.authIdMatchAll(steamId);
        const valid = serverList.filter((s) => s && TABLE_NAME_RE.test(s.tbl_name));
        // Servers are independent: query in parallel, and one bad/missing
        // table must not nuke the whole dashboard (that surfaced as "no VIP").
        const settled = await Promise.all(valid.map(async (s) => {
          try {
            const query = db.queryFormat(`SELECT authId,
                                                 name,
                                                 expireStamp,
                                                 created_at,
                                                 type
                                          FROM ${s.tbl_name} WHERE authId IN (?)`, [matchIds]);
            const queryRes = await db.query(query);
            if (queryRes && queryRes.length) return { "servername": s.server_name, "data": queryRes[0] };
          } catch (e) {
            logger.error("error in getUserDataFromAllServers (single server)->", e);
          }
          return null;
        }));
        return resolve(settled.filter(Boolean));
      } catch (error) {
        logger.error("error in getUserDataFromAllServers->", error);
        reject(error)
      }
    });
  },


  /**
   * get stats for admin
   */
  getStatsForAdmin: function () {
    return new Promise(async (resolve, reject) => {
      try {
        let finalResult = {}
        let userCount = 0

        let serverList = await panelServerModal.getPanelServersDisplayList();

        for (let i = 0; i < serverList.length; i++) {
          if (!TABLE_NAME_RE.test(serverList[i].tbl_name)) continue;
          let query = db.queryFormat(`SELECT COUNT(authId) AS usercount FROM ${serverList[i].tbl_name}`);
          let queryRes = await db.query(query, true);
          if (!queryRes) {
            return reject("No Data Found");
          }
          userCount = userCount + (queryRes.usercount / 1)
        }

        let query = db.queryFormat(`SELECT COUNT(id) AS totalservers FROM ${serverTable}`);
        let queryRes = await db.query(query, true);
        if (!queryRes) {
          return reject("No Data Found");
        }
        const totalservers = queryRes.totalservers

        query = db.queryFormat(`SELECT (SELECT COUNT(id) FROM ${salestable} WHERE sale_type=1) as buycount, (SELECT COUNT(id) FROM ${salestable} WHERE sale_type=2) as renewcount `);
        queryRes = await db.query(query, true);
        if (!queryRes) {
          return reject("No Data Found");
        }
        const totalbuy = queryRes.buycount
        const totalrenew = queryRes.renewcount

        finalResult = {
          "serverCount": totalservers,
          "userCount": userCount,
          "saleCount": totalbuy,
          "renewSaleCount": totalrenew
        }

        return resolve(finalResult);
      } catch (error) {
        logger.error("error in getStatsForAdmin->", error);
        reject(error)
      }
    });
  },


  /**
 * get server listing (secret-free projection + parallel count queries)
 */
  getSaleServerListing: function () {
    return new Promise(async (resolve, reject) => {
      try {

        const serverList = await panelServerModal.getPanelServersSaleListing();
        const counts = await Promise.all(serverList.map(async (s) => {
          if (!TABLE_NAME_RE.test(s.tbl_name)) return null;
          const query = db.queryFormat(`SELECT COUNT(authId) AS usercount FROM ${s.tbl_name} WHERE type = 0`);
          return db.query(query, true).catch(() => null);
        }));

        const serverArray = []
        for (let i = 0; i < serverList.length; i++) {
          const usercount = counts[i] ? counts[i].usercount : 0;
          if (usercount < serverList[i].vip_slots) {
            const { ...safeRow } = serverList[i]; // copy: rcon was never selected
            serverArray.push(safeRow);
          }
        }
        return resolve(serverArray);
      } catch (error) {
        logger.error("error in getStatsForAdmin->", error);
        reject(error)
      }
    });
  },


}

module.exports = myDashboardModel;
