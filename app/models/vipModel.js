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

const logger = require('../modules/logger')('VIP model');
var db = require('../db/db_bridge');
const panelServerModal = require("../models/panelServerModal.js");
const { refreshAdminsInServer } = require("../utils/refreshCFGInServer")

  /**
 * Allow-list for dynamic per-server table names (created by the SourceMod plugin).
 * Identifiers cannot be bound with `?` placeholders, so validate strictly.
 */
const TABLE_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
function assertTableName(name) {
  if (!name || typeof name !== 'string' || !TABLE_NAME_RE.test(name)) {
    throw new Error('Invalid server table name');
  }
  return name;
}

function escapeLike(s) {
  return String(s).replace(/[%_\\]/g, (c) => '\\' + c);
}
var vipDataModel = {

  /**
   * get all the data form the table
   */
  getAllServerData: function () {
    return new Promise(async (resolve, reject) => {
      try {
        let finalResult = []
        let serverList = await panelServerModal.getPanelServersDisplayList();

        for (let i = 0; i < serverList.length; i++) {
          assertTableName(serverList[i].tbl_name);
          let query = db.queryFormat(`SELECT authId,
                                             name,
                                             expireStamp,
                                             created_at,
                                             type 
                                      FROM ${serverList[i].tbl_name} WHERE type = 0`);
          let queryRes = await db.query(query);
          if (!queryRes) {
            return reject("No Data Found");
          }
          finalResult.push({ "servername": serverList[i].server_name, "type": "VIPs", "data": queryRes })

          query = db.queryFormat(`SELECT authId,
                                         name,
                                         expireStamp,
                                         created_at,
                                         type 
                                  FROM ${serverList[i].tbl_name} WHERE type = 1`);
          queryRes = await db.query(query);
          if (!queryRes) {
            return reject("No Data Found");
          }
          finalResult.push({ "servername": serverList[i].server_name, "type": "ADMINs", "data": queryRes })
        }
        return resolve(finalResult);
      } catch (error) {
        logger.error("error in getallTableData->", error);
        reject(error)
      }
    });
  },

  /**
 * get single server listing
 */
  getSingleServerData: function (server, search, type) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!server) return reject("Server is not Provided");
        if (!type) return reject("User type is not Provided");
        assertTableName(server);

        // LIKE pattern uses a bound parameter; % _ \ in user input are escaped.
        const likeParam = search ? `%${escapeLike(search)}%` : null;
        let query
        if (type === "vip") {
          query = search
            ? db.queryFormat(`SELECT * FROM ${server} WHERE type = 0 AND name LIKE ? ESCAPE '\\\\'`, [likeParam])
            : db.queryFormat(`SELECT * FROM ${server} WHERE type = 0`);
        } else if (type === "admin") {
          query = search
            ? db.queryFormat(`SELECT * FROM ${server} WHERE type = 1 AND name LIKE ? ESCAPE '\\\\'`, [likeParam])
            : db.queryFormat(`SELECT * FROM ${server} WHERE type = 1`);
        } else {
          return reject("Invalid user type");
        }
        let queryRes = await db.query(query);
        if (!queryRes) {
          return reject("No Data Found");
        }
        return resolve(queryRes);
      } catch (error) {
        logger.error("error in getSingleServerData->", error);
        reject(error)
      }
    });
  },

  /**
   * insert new vip (single transaction across selected servers)
   */
  insertVIPData: function (dataObj) {
    return new Promise(async (resolve, reject) => {
      try {
        // validation
        if (!dataObj.secKey) return reject("Unauth Access, Key Missing");
        if (dataObj.server.length == 0) return reject("Operation Fail!, No Server was selected");

        let currentDateTime = new Date()
        const expireStamp = Number(dataObj.day);
        if (!Number.isFinite(expireStamp)) return reject("Invalid expiry value");
        for (let i = 0; i < dataObj.server.length; i++) {
          assertTableName(dataObj.server[i]);
        }
        await db.withTransaction(async (exec) => {
          for (let i = 0; i < dataObj.server.length; i++) {
            const query = db.queryFormat(`INSERT INTO ${dataObj.server[i]} 
                                          (authId,
                                          flag,
                                          name,
                                          created_at,
                                          expireStamp,
                                          type) VALUES (?, ?, ?, ?, ?, ?)`, [dataObj.steamId, dataObj.flag, dataObj.name, currentDateTime, dataObj.day, dataObj.userType]);
            const queryRes = await exec(query);
            if (!queryRes) {
              throw new Error("error in insertion");
            }
          }
        });
        return resolve(true);
      } catch (error) {
        logger.error("error in insertVIPData->", error);
        reject(error)
      }
    });
  },

  /**
  * update old vip (single transaction across selected servers)
  */
  updateVIPData: function (dataObj) {
    return new Promise(async (resolve, reject) => {
      try {
        // validation
        if (!dataObj.secKey) return reject("Unauth Access, Key Missing");
        if (dataObj.server.length == 0) return reject("Operation Fail!, No Server was selected");

        for (let i = 0; i < dataObj.server.length; i++) {
          assertTableName(dataObj.server[i]);
        }
        const addSeconds = Math.floor(Number(dataObj.day));
        if (!Number.isFinite(addSeconds)) return reject("Invalid expiry value");
        await db.withTransaction(async (exec) => {
          for (let i = 0; i < dataObj.server.length; i++) {
            const query = db.queryFormat(`UPDATE ${dataObj.server[i]} SET expireStamp = expireStamp + ? WHERE authId=?`, [addSeconds, dataObj.steamId]);
            const queryRes = await exec(query);
            if (!queryRes) {
              throw new Error("error in update");
            }
          }
        });
        return resolve(true);
      } catch (error) {
        logger.error("error in updateVIPData->", error);
        reject(error)
      }
    });
  },

  /**
  * delete old vip
  */
  deleteOldVip: function () {
    return new Promise(async (resolve, reject) => {
      try {

        let currentEpoc = Math.floor(Date.now() / 1000)
        let serverList = await panelServerModal.getPanelServersDisplayList();

        for (let i = 0; i < serverList.length; i++) {
          assertTableName(serverList[i].tbl_name);
          let query = db.queryFormat(`DELETE FROM ${serverList[i].tbl_name} where expireStamp < ? AND type = 0 `, [currentEpoc]);
          let queryRes = await db.query(query);
          if (!queryRes) {
            return reject("Error in delete");
          }
          await refreshAdminsInServer(serverList[i].tbl_name);
        }
        return resolve(true);
      } catch (error) {
        logger.error("error in deleteOldVip->", error);
        reject(error)
      }
    });
  },


  /**
* delete vip by admin
*/
  deleteVipByAdmin: function (dataObj) {
    return new Promise(async (resolve, reject) => {
      try {

        if (!dataObj.secKey) return reject("Unauth Access, Key Missing");
        assertTableName(dataObj.tableName);
        let query = db.queryFormat(`DELETE FROM ${dataObj.tableName} where authId = ? `, [dataObj.primaryKey]);
        let queryRes = await db.query(query);
        if (!queryRes) {
          return reject("Error in delete");
        }
        return resolve(true);
      } catch (error) {
        logger.error("error in deleteVipByAdmin->", error);
        reject(error)
      }
    });
  },

  /**
* Check if vip exists
*/
  checkVipExists: function (dataObj) {
    return new Promise(async (resolve, reject) => {
      try {

        if (!dataObj.server) return reject("Server Missing in VIP Check");
        if (!dataObj.steamId) return reject("Auth Id Missing in VIP Check");
        assertTableName(dataObj.server);
        let query = db.queryFormat(`SELECT name from ${dataObj.server} where authId = ? `, [dataObj.steamId]);
        let queryRes = await db.query(query, true);
        return resolve(queryRes);
      } catch (error) {
        logger.error("error in checkVipExists->", error);
        reject(error)
      }
    });
  }

}

module.exports = vipDataModel;