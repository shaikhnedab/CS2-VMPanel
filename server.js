/*  VMP-by-Summer-Soldier
 *
 *  Copyright (C) 2021 SUMMER SOLDIER - (SHIVAM PARASHAR)
 *
 *  This file is part of VMP-by-Summer-Soldier
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

try { require('dotenv').config(); } catch (e) { /* dotenv optional in production */ }

const config = require('./app/config');
const scheduleConfig = config.scheduleConfig;
const logger = require('./app/modules/logger')('Server');
const express = require("express");
const cron = require('node-cron');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam');
const cors = require('cors');

const requestMiddleware = require('./app/middleWares/request');
const requestLogger = require('./app/middleWares/requestLogger');
const csrfMiddleware = require('./app/middleWares/csrf');
const notFoundMiddleware = require('./app/middleWares/not_found');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const vipModel = require("./app/models/vipModel.js");
const settingsModal = require("./app/models/panelSettingModal.js");
const dbBootstrap = require('./app/db/bootstrap');
const { sendMessageOnDiscord } = require("./app/controllers/sendMessageOnDiscord.js");
const { logThisActivity } = require("./app/utils/activityLogger.js");

passport.serializeUser(function (user, done) {
  done(null, user);
});

passport.deserializeUser(function (obj, done) {
  done(null, obj);
});

passport.use(new SteamStrategy({
  returnURL: ((config.apacheProxy) ? ('http://' + config.hostname) : ('http://' + config.hostname + ':' + config.serverPort)) + '/auth/steam/return',
  realm: ((config.apacheProxy) ? ('http://' + config.hostname) : ('http://' + config.hostname + ':' + config.serverPort)) + '/',
  apiKey: config.steam_api_key
},
  function (identifier, profile, done) {
    // asynchronous verification, for effect...
    process.nextTick(function () {
      profile.identifier = identifier;
      return done(null, profile);
    });
  }
));


const app = express();

app.set('view engine', 'ejs');
app.set('trust proxy', config.apacheProxy ? 1 : 0);

app.use(requestMiddleware.addRequestUUID);
app.use(requestLogger);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.static('public'));

// Throttle credential + payment endpoints (per-IP)
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use(['/adminlogin', '/auth/steam'], loginLimiter);

app.use(session({
  secret: config.app.secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: config.apacheProxy ? true : false,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// CSRF tokens (minted per session) are needed before the per-request locals
// middleware so every page can expose them. Parsers must run before verify.
app.use(csrfMiddleware.ensureCsrf);

app.use(cors({ origin: false }));

// parse requests of content-type - application/json
app.use(express.json({
  limit: '1mb',
  extended: true
}));

// parse requests of content-type - application/x-www-form-urlencoded
app.use(express.urlencoded({
  limit: '1mb',
  extended: true
}));

// CSRF: every non-safe request must carry the session token.
// Exceptions: statics already served earlier; Steam OpenID handback is a GET.
app.use(csrfMiddleware.verifyCsrf);

cron.schedule(`0 */${scheduleConfig.delete} * * *`, async () => {
  logger.info("****Schedule call Deleting old VIP****");
  await vipModel.deleteOldVip()
  logThisActivity({
    "activity": "Expired VIPs cleaned up",
    "additional_info": "Expired VIPs removed and server configs refreshed",
    "created_by": "By Panel Cron"
  })
});

cron.schedule(`0 */${scheduleConfig.notif} * * *`, async () => {
  logger.info("****Schedule call Sending Notification on Discord****");
  sendMessageOnDiscord()
});

// middleware to make 'user' available to all templates
app.use(async function (req, res, next) {
  res.locals.panelSetting = await settingsModal.getAllSettings();
  res.locals.sessionToken = req.session.token;
  res.locals.adminName = req.session.username;
  res.locals.currentURL = req.originalUrl;
  res.locals.adminType = req.session.user_type;
  res.locals.defaultCredWarning = req.session.defaultCredWarning ? true : false;

  res.locals.sessionSteamId = req.session.passport ? req.session.passport.user.id : null;
  res.locals.steamName = req.session.passport ? req.session.passport.user.displayName : null;
  next();
});

require("./app/routes/router.js")(app);
app.use(notFoundMiddleware.notFound);
app.use(require('./app/middleWares/errorHandler'));

// Start the server after db bootstrapping
dbBootstrap().then(() => {
  // set port, listen for requests
  const PORT = process.env.PORT || config.serverPort;
  app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}.`);
  });
}).catch((error) => {
  logger.error("Error while doing database bootstrapping Error:", error);
  process.exit(1);
});

// ========== process error handling [ start ] ==========
process.on('uncaughtException', err => {
  logger.error("'uncaughtException' occurred! \n error:", err);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', reason.stack || reason);
});
// ========== process error handling [ end ] ==========
