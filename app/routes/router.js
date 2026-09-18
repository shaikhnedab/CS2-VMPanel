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

module.exports = app => {

  // Middleware Import
  const authMiddleware = require('../middleWares/auth');
  const passport = require('passport');
  const config = require('../config');
  const { steamReturnUrl, steamRealm, buildSteamStrategy } = require('../utils/steamOpenId');
  // Steam OpenID must return to the address the browser actually used, not a
  // static HOSTNAME (container hostnames, IP:port access, proxies). Rebuild
  // the strategy per request; the in-flight request holds its own instance.
  const useRequestSteamStrategy = (req) => {
    passport.use(buildSteamStrategy(steamReturnUrl(req), steamRealm(req), config.steam_api_key));
  };

  // Controllers Import
  const { dashboard, getVipsDataSingleServer, getAdminsDataSingleServer } = require("../controllers/vipController.js");
  const { insertVipData, formVIP } = require("../controllers/insertVip.js");
  const { insertAdminData, formAdmin } = require("../controllers/insertAdmin.js");
  const { deleteVipData, deleteOldVipData } = require("../controllers/deleteVip.js");
  const { loginPage, authUserLogin } = require("../controllers/login.js");
  const { PanelSettings, fetchPanelSettings, updatePanelSettings } = require("../controllers/panelSettings.js")
  const { addPanelAdmin, getPanelAdminsList, deletePanelAdmin } = require("../controllers/panelAdmins.js")
  const { getPanelServersList, getPanelServerSingle, addPanelServer, deletePanelServers } = require("../controllers/panelServers.js")
  const { fetchProfileData } = require("../controllers/steamProfileDataFetch.js")
  const { myDashboard, afterPaymentProcess } = require("../controllers/userDashboard.js")
  const { resolveRecipient } = require("../controllers/giftRecipient.js")
  const resolveLimiter = require('express-rate-limit')({
    windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  });
  const { saleRecords, getSalesRecord } = require("../controllers/salesRecord.js")
  const { auditRecords, getAuditRecord } = require("../controllers/auditLogs.js")
  const { initPayUPayment } = require("../controllers/payU.js")
  const { initRazorpayPayment } = require('../controllers/razorPay');
  const { addPanelServerBundle, getPanelBundlesList, deletePanelBundle } = require("../controllers/panelServerBundles.js")

  //Public Router
  app.get("/", dashboard);
  app.get("/dashboard", dashboard);


  //Login and logout
  app.get('/login', loginPage);
  app.get('/adminlogin', loginPage);
  app.post('/adminlogin', authUserLogin);
  app.get('/logout', function (req, res, next) {
    req.logout(function (err) {
      if (err) { return next(err); }
      req.session.destroy(function () {
        res.redirect('/');
      });
    });
  });

  //route to fetch user data from steam profile
  app.post('/fetchsteamprofiledata', fetchProfileData);

  //Private Router only for User (Steam Authorized)
  app.get('/auth/steam',
    (req, res, next) => { useRequestSteamStrategy(req); return next(); },
    passport.authenticate('steam', { failureRedirect: '/' }),
    function (req, res) {
      res.redirect('/');
    });

  app.get('/auth/steam/return',
    (req, res, next) => { useRequestSteamStrategy(req); return next(); },
    passport.authenticate('steam', { failureRedirect: '/' }),
    function (req, res) {
      res.redirect('/mydashboard');
    });

  app.get('/mydashboard', authMiddleware.checkSteamAuthenticated, myDashboard);
  app.post('/execafterpaymentprocess', authMiddleware.checkSteamAuthenticated, afterPaymentProcess);
  app.post('/initpayupayment', authMiddleware.checkSteamAuthenticated, initPayUPayment);
  app.get('/getpanelbundleslistud', authMiddleware.checkSteamAuthenticated, getPanelBundlesList);

  // RazorPay routes
  app.post('/initrazorpaypayment', authMiddleware.checkSteamAuthenticated, initRazorpayPayment);

  // Gift receiver verification (Steam-logged-in buyers only, rate-limited)
  app.post('/resolverecipient', resolveLimiter, authMiddleware.checkSteamAuthenticated, resolveRecipient);

  //Private Router only for Panel Admins (Local Authorized)
  //Vip routes
  app.post("/getvipdatasingleserver", authMiddleware.checkToken, getVipsDataSingleServer);
  app.get("/managevip", authMiddleware.checkToken, formVIP);
  app.post("/addvip", authMiddleware.checkToken, insertVipData);
  app.post("/deletevip", authMiddleware.checkToken, deleteVipData);

  //Admin routes 
  app.post("/getadmindatasingleserver", authMiddleware.checkToken, getAdminsDataSingleServer);
  app.get("/manageadmin", authMiddleware.checkToken, formAdmin);
  app.post("/addadmin", authMiddleware.checkToken, insertAdminData);

  //Panel Settings routes
  app.get('/panelsetting', authMiddleware.checkToken, PanelSettings);
  app.get('/fetchpanelsetting', authMiddleware.checkToken, fetchPanelSettings);
  app.post('/updatepanelsetting', authMiddleware.checkToken, updatePanelSettings);

  //Panel server mange routes
  app.get("/getpanelserverlist", authMiddleware.checkToken, getPanelServersList);
  app.post("/getpanelserversingle", authMiddleware.checkToken, getPanelServerSingle);
  app.post("/addpanelserver", authMiddleware.checkToken, addPanelServer);
  app.post("/deletepanelserver", authMiddleware.checkToken, deletePanelServers);

  //Panel server bundl mange routes
  app.get("/getpanelbundleslist", authMiddleware.checkToken, getPanelBundlesList);
  app.post("/addpanelserverbundle", authMiddleware.checkToken, addPanelServerBundle);
  app.post("/deletepanelbundle", authMiddleware.checkToken, deletePanelBundle);

  //Panel Admin routes (super-admin only for writes; list also restricted)
  app.get("/getpaneladminslist", authMiddleware.checkToken, authMiddleware.requireSuperAdmin, getPanelAdminsList);
  app.post("/addpaneladmin", authMiddleware.checkToken, authMiddleware.requireSuperAdmin, addPanelAdmin);
  app.post("/updatepaneladmin", authMiddleware.checkToken, authMiddleware.requireSuperAdmin, addPanelAdmin);
  app.post("/deletepaneladmin", authMiddleware.checkToken, authMiddleware.requireSuperAdmin, deletePanelAdmin);

  //Route to manually refresh data in all servers (POST only; GET kept for backwards compat)
  app.post("/performmanualrefresh", authMiddleware.checkToken, deleteOldVipData);

  //Routes for Sales Records (super-admin only)
  app.get("/salesrecord", authMiddleware.checkToken, authMiddleware.requireSuperAdmin, saleRecords);
  app.post("/fetchsalesrecord", authMiddleware.checkToken, authMiddleware.requireSuperAdmin, getSalesRecord);

  //Routes for Audit logs (super-admin only)
  app.get("/auditlogs", authMiddleware.checkToken, authMiddleware.requireSuperAdmin, auditRecords);
  app.post("/fetchauditlogs", authMiddleware.checkToken, authMiddleware.requireSuperAdmin, getAuditRecord);
};