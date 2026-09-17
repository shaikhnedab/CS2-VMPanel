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
const logger = require('../modules/logger')('User Model');
var db = require('../db/db_bridge');
const config = require('../config');
const table = config.usersTable
const crypto = require('crypto');

function newSecKey() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 *   User Model
 */
var userDataModel = {

  /**
 * create table if not exists
 */
  createTheTableIfNotExists: function () {
    return new Promise(async (resolve, reject) => {
      try {

        let query = db.queryFormat(`CREATE TABLE IF NOT EXISTS ${table} (
                                    id int(11) NOT NULL AUTO_INCREMENT,
                                    username varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL,
                                    password varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
                                    sec_key varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
                                    user_type int(11) NOT NULL,
                                    PRIMARY KEY(id)
                                  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci`);
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
   * create the initial super-admin account (first-boot wizard only)
   */
  createAdmin: function ({ username, hash, user_type } = {}) {
    return new Promise(async (resolve, reject) => {
      try {

        // validation
        if (!username) return reject("Username is not provided");
        if (!hash) return reject("Password hash is not provided");

        const adminType = Number(user_type) === 0 ? 0 : 1;
        let query = db.queryFormat(`INSERT INTO ${table}
                                    (username,password,sec_key,user_type)
                                    VALUES (?, ?, ?, ?)`, [username, hash, newSecKey(), adminType]);
        let queryRes = await db.query(query, true);
        if (!queryRes) {
          return reject("Error while filling entry in table");
        }
        return resolve(queryRes);
      } catch (error) {
        logger.error("error in createAdmin->", error);
        reject(error)
      }
    });
  },

  /**
   * get all the user data form the table
   */
  getUserDataByUsername: function (username) {
    return new Promise(async (resolve, reject) => {
      try {

        // validation
        if (!username) return reject("Username is not provided");

        let query = db.queryFormat(`SELECT * FROM ${table} WHERE username = ?`, [username]);
        let queryRes = await db.query(query, true);
        if (!queryRes) {
          return reject("Username dont Exist");
        }
        return resolve(queryRes);
      } catch (error) {
        logger.error("error in getallTableData->", error);
        reject(error)
      }
    });
  },

  /**
* get list of all admins
*/
  getListOfAdmins: function () {
    return new Promise(async (resolve, reject) => {
      try {

        let query = db.queryFormat(`SELECT id,username FROM ${table}`);
        let queryRes = await db.query(query);
        if (!queryRes) {
          return reject("no data found");
        }
        return resolve(queryRes);
      } catch (error) {
        logger.error("error in getListOfAdmins->", error);
        reject(error)
      }
    });
  },

  /**
 * Insert a new user
 */
  insertNewUser: function (dataObj) {
    return new Promise(async (resolve, reject) => {
      try {

        // validation
        if (!dataObj.username) return reject("Username is not provided");
        if (!dataObj.password) return reject("Password is not provided");

        let query = db.queryFormat(`INSERT INTO ${table} (username, password, sec_key, user_type) VALUES (?, ?, ?, ?)`, [dataObj.username, dataObj.password, newSecKey(), dataObj.admintype]);
        let queryRes = await db.query(query, true);
        if (!queryRes) {
          return reject("Error in insertion");
        }
        return resolve(queryRes);
      } catch (error) {
        logger.error("error in insertNewUser->", error);
        if (error && (error.code === 'ER_DUP_ENTRY' || /duplicate/i.test(error.sqlMessage || ''))) {
          return reject("That username is already taken. Pick another one.");
        }
        reject(error)
      }
    });
  },

  /**
 * Insert a new user
 */
  updateUserpassword: function (dataObj) {
    return new Promise(async (resolve, reject) => {
      try {

        // validation
        if (!dataObj.id) return reject("id is not provided");
        if (!dataObj.username) return reject("username is not provided");
        if (!dataObj.password) return reject("Password is not provided");

        let query = db.queryFormat(`UPDATE ${table} SET password = ?, sec_key = ? WHERE id = ? AND username = ?`, [dataObj.password, newSecKey(), dataObj.id, dataObj.username]);
        let queryRes = await db.query(query, true);
        if (!queryRes) {
          return reject("Error in Update");
        }
        return resolve(queryRes);
      } catch (error) {
        logger.error("error in updateUserpassword->", error);
        reject(error)
      }
    });
  },

  /**
* Delete a  user
*/
  deleteUser: function (dataObj) {
    return new Promise(async (resolve, reject) => {
      try {

        // validation
        if (!dataObj.id) return reject("id is not provided");
        if (!dataObj.username) return reject("username is not provided");

        let query = db.queryFormat(`DELETE FROM ${table} WHERE id = ? AND username = ?`, [dataObj.id, dataObj.username]);
        let queryRes = await db.query(query, true);
        if (!queryRes) {
          return reject("Error in delete");
        }
        return resolve(queryRes);
      } catch (error) {
        logger.error("error in deleteUser->", error);
        reject(error)
      }
    });
  },

}

module.exports = userDataModel;