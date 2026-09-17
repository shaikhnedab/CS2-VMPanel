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
const logger = require('../modules/logger')('MySQL Connection');

const mysql = require('mysql2/promise');
const config = require('../config');

let pool = null;
let keepaliveHandle = null;

function buildOptions() {
  const dbConfig = (config && config.db) || {};
  return {
    connectionLimit: 20, //important
    host: dbConfig.db_host,
    user: dbConfig.db_user,
    password: dbConfig.db_password,
    database: dbConfig.db_name,
    port: dbConfig.db_port,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    waitForConnections: true,
    charset: 'utf8mb4',
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    namedPlaceholders: true,
    timezone: 'Z',
    // debug: true
  };
}

function ensureKeepalive() {
  if (keepaliveHandle) return;
  try {
    // Keep the pool warm through long idle windows (e.g. low-traffic panels
    // behind the cron-driven delete/notify jobs).
    const handle = setInterval(() => {
      if (!pool) return;
      pool.query('SELECT 1').catch((error) => {
        logger.error('Pool keepalive ping failed:', error && error.message);
      });
    }, 5 * 60 * 1000);
    // Don't keep the process alive on its own (tests / short-lived runners).
    if (typeof handle.unref === 'function') handle.unref();
    keepaliveHandle = handle;
  } catch (error) {
    logger.error('Pool keepalive setup error:', error);
  }
}

function getPool() {
  if (pool) return pool;
  try {
    pool = mysql.createPool(buildOptions());
    ensureKeepalive();
  } catch (error) {
    logger.error('Connection Pool Error : ', error);
    throw error;
  }
  return pool;
}

async function resetPool() {
  await closePool();
  return getPool();
}

async function closePool() {
  const p = pool;
  pool = null;
  if (keepaliveHandle) {
    try { clearInterval(keepaliveHandle); } catch (e) { /* ignore */ }
    keepaliveHandle = null;
  }
  if (p) {
    try { await p.end(); } catch (e) { /* ignore close errors */ }
  }
}

module.exports = {
  getPool,
  resetPool,
  closePool,
};
