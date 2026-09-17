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

const pool = require('./connection');
const mysql = require('mysql2');

/**
 * Executes SQL query and returns data.
 * @constructor
 * @param {string} queryText - SQL query string
 * @param {boolean} singleRecord - single record
 */
const query = async function (queryText, singleRecord) {
    const [results] = await pool.query(queryText);
    return normalize(results, singleRecord);
};

function normalize(results, singleRecord) {
    if (Array.isArray(results)) {
        const finalResults = results.map((r) => ({ ...r }));
        // For single record
        if (typeof (singleRecord) == "boolean" && singleRecord) return finalResults[0];
        // For multiple records
        return finalResults;
    }
    return results;
}

/**
 * Run fn(conn) inside a transaction; commits on resolve, rolls back on throw.
 * fn receives a connection whose .query() accepts the same (text, singleRecord)
 * signature as db.query, so models stay unchanged.
 */
const withTransaction = async function (fn) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const exec = async (queryText, singleRecord) => {
            const [results] = await conn.query(queryText);
            return normalize(results, singleRecord);
        };
        const result = await fn(exec, conn);
        await conn.commit();
        return result;
    } catch (error) {
        try { await conn.rollback(); } catch (e) { /* rollback already done */ }
        throw error;
    } finally {
        conn.release();
    }
};

/**
 * shim for formatting the query
 */
var queryFormat = mysql.format;

/**
 * escaping the data
 */
var dataEscape = mysql.escape;

module.exports = {
    dbPool: pool,
    query,
    queryFormat,
    dataEscape,
    withTransaction,
    normalize
};