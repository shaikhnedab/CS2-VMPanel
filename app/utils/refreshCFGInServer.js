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
const logger = require('../modules/logger')('refresh CGF');

//-----------------------------------------------------------------------------------------------------
//

const DEFAULT_REFRESH_CMD = 'css_viprefresh';

// Per-server refresh command: custom string (e.g. `sm_vipRefresh` for classic
// SourceMod boxes), panel default otherwise. Pure — safe to unit test.
const refreshCommandFor = (serverDetails) => {
  const custom = serverDetails && serverDetails.rcon_refresh_cmd;
  if (typeof custom === 'string' && custom.trim() !== '') return custom.trim();
  return DEFAULT_REFRESH_CMD;
};

// Best-effort liveness probe. Never throws, never vetoes: UDP game queries
// are routinely filtered while RCON works fine, so a silent server must NOT
// skip the refresh. The RCON handshake itself is the real liveness proof.
const probeServer = (ip, port) => {
  return new Promise((resolve) => {
    let settled = false;
    const done = (alive) => { if (!settled) { settled = true; resolve(alive); } };
    try {
      const SourceQuery = require('sourcequery');
      const sq = new SourceQuery(1000); // 1000ms timeout
      try { sq.open(ip, port); } catch (e) { try { sq.close(); } catch (ce) { /* ignore */ } return done(false); }
      sq.getInfo((err) => { try { sq.close(); } catch (e) { /* ignore */ } done(!err); });
      setTimeout(() => { try { sq.close(); } catch (e) { /* ignore */ } done(false); }, 3000);
    } catch (e) {
      done(false);
    }
  });
};

// Single RCON round-trip. Resolves on clean disconnect after auth+send,
// rejects on transport/auth errors. Requires are lazy so tests can stub them.
const sendRconCommand = (ip, port, pass, cmd) => {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      const Rcon = require('rcon');
      const conn = new Rcon(ip, port, pass);
      conn.on('auth', function () {
        logger.info('*** Rcon Authorized! ***');
        logger.info('*** [RCON] Sending command: ' + cmd);
        conn.send(cmd);
        conn.disconnect();
      }).on('response', function (str) {
        logger.info('*** [RCON] Got response: ' + str);
      }).on('error', function (error) {
        logger.error('*** [RCON] Got error: ' + error);
        if (!settled) { settled = true; reject(new Error('RCON failed — check the server RCON password and port in Panel Settings')); }
      }).on('end', function () {
        logger.info('*** [RCON] Socket closed!');
        if (!settled) { settled = true; resolve(true); }
      });
      conn.connect();
    } catch (e) {
      if (!settled) { settled = true; reject(e); }
    }
  });
};

const refreshAdminsInServer = (server) => {
  return new Promise(async (resolve, reject) => {
    try {
      const panelServerModal = require('../models/panelServerModal.js');
      const serverDetails = await panelServerModal.getPanelServerDetails(server);

      if (!serverDetails.server_ip || !serverDetails.server_port || !serverDetails.server_rcon_pass) {
        return resolve(0);
      }
      const live = await probeServer(serverDetails.server_ip, serverDetails.server_port);
      if (!live) logger.info('*** [RCON] Query unanswered — attempting RCON anyway');
      try {
        await sendRconCommand(
          serverDetails.server_ip,
          serverDetails.server_port,
          serverDetails.server_rcon_pass,
          refreshCommandFor(serverDetails)
        );
        return resolve(1);
      } catch (e) {
        logger.error('error in refreshAdminsInServer->', e);
        return reject('Operation Done in VMPanel Database,\n RCON failed — check the server RCON password and port in Panel Settings. ');
      }
    } catch (error) {
      logger.error('error in refreshAdminsInServer->', error);
      reject('Operation Done in VMPanel Database,\n There was an error while executing rcon Command for current Operation. ');
    }
  });
};

exports.refreshAdminsInServer = refreshAdminsInServer;
exports.refreshCommandFor = refreshCommandFor;
exports.probeServer = probeServer;
exports.sendRconCommand = sendRconCommand;
exports.DEFAULT_REFRESH_CMD = DEFAULT_REFRESH_CMD;

// Never rejects: an RCON failure degrades to 0 so database writes (VIP add,
// purchase, expiry cleanup) survive a dead game server. Controllers report
// the 0 in their toasts instead of failing the whole operation.
const refreshBestEffort = async (server) => {
  try {
    return await refreshAdminsInServer(server);
  } catch (e) {
    return 0;
  }
};
exports.refreshBestEffort = refreshBestEffort;
