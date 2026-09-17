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
const crypto = require('crypto');

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
const registerInstallRoutes = require('./app/routes/install');

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

function isCompleteNow() {
  try {
    const install = require('./app/routes/install');
    if (install && typeof install.isComplete === 'function' && install.isComplete()) return true;
  } catch (e) { /* ignore */ }
  try {
    return config.isSetupComplete();
  } catch (e) {
    return false;
  }
}

// First-boot gate. When setup is incomplete every request outside the
// allowlist is sent to the wizard; once setup is complete the wizard
// itself is closed (404) and never reopens on later DB errors.
function installGate(req, res, next) {
  const complete = isCompleteNow();
  const url = (req.path || String(req.originalUrl || '').split('?')[0] || '');
  const isInstall = url === '/install' || url.startsWith('/install/');
  const isHealth = url === '/healthz';
  const isPublic = url.startsWith('/public/');
  if (!complete) {
    const methodOk = req.method === 'GET' || req.method === 'POST' || req.method === 'HEAD';
    if ((isInstall && (req.method === 'GET' || req.method === 'POST')) || isHealth || isPublic) return next();
    if (isHealth && !methodOk) return next();
    return res.redirect(302, '/install');
  }
  if (isInstall) {
    // The gate runs before session/locals middleware, so seed the minimum
    // view locals the 404 layout expects (never touch the database here —
    // this path must stay closed even when the DB is unreachable).
    try {
      res.locals.panelSetting = res.locals.panelSetting || {};
      res.locals.csrfToken = '';
      res.locals.sessionToken = null;
      res.locals.adminName = null;
      res.locals.currentURL = req.originalUrl;
      res.locals.adminType = null;
      res.locals.sessionSteamId = null;
      res.locals.steamName = null;
    } catch (e) { /* render may fall back below */ }
    try {
      return res.status(404).render('404');
    } catch (e) {
      return res.status(404).send('Not found');
    }
  }
  return next();
}

let cronScheduled = false;

function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('trust proxy', config.apacheProxy ? 1 : 0);

  // Install gate runs before everything else.
  app.use(installGate);

  app.use(requestMiddleware.addRequestUUID);
  app.use(requestLogger);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(express.static('public'));

  // Throttle credential + payment endpoints (per-IP)
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
  app.use(['/adminlogin', '/auth/steam'], loginLimiter);

  let setupCompleteAtBoot = false;
  try { setupCompleteAtBoot = config.isSetupComplete(); } catch (e) { setupCompleteAtBoot = false; }
  const sessionSecret = (setupCompleteAtBoot && config.app && config.app.secret)
    ? config.app.secret
    : crypto.randomBytes(32).toString('hex');

  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // 'auto' (express-session >= 1.17): Secure flag only on encrypted
      // connections (direct HTTPS or trusted proxy X-Forwarded-Proto). A
      // forced Secure cookie is silently dropped by browsers on plain HTTP,
      // which breaks sessions — including login — on direct-HTTP deployments.
      secure: config.apacheProxy ? 'auto' : false,
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
  // Exceptions: statics already served earlier; Steam OpenID handback is a GET;
  // /install* enforces its own cookie-independent token (the wizard must work
  // in browsers that block cookies) plus a strict rate limit — see
  // app/routes/install.js. Post-setup the gate above 404s /install* anyway.
  app.use((req, res, next) => {
    if (req.path === '/install' || req.path.startsWith('/install/')) return next();
    csrfMiddleware.verifyCsrf(req, res, next);
  });

  // Liveness probe — no DB, no auth.
  app.get('/healthz', (req, res) => {
    res.status(200).json({ ok: true });
  });

  if (setupCompleteAtBoot && !cronScheduled) {
    cronScheduled = true;
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
  }

  // middleware to make 'user' available to all templates
  app.use(async function (req, res, next) {
    if (!isCompleteNow()) {
      // First-boot wizard mode: never touch the database here. The wizard
      // is self-contained; probing it only spams ENOTFOUND logs when the
      // user has not configured (or cannot yet reach) their database.
      res.locals.panelSetting = {};
      res.locals.dbUnreachable = true;
    } else {
      try {
        res.locals.panelSetting = await settingsModal.getAllSettings();
        res.locals.dbUnreachable = false;
      } catch (e) {
        res.locals.panelSetting = {};
        res.locals.dbUnreachable = true;
      }
    }
    try {
      res.locals.sessionToken = req.session.token;
      res.locals.adminName = req.session.username;
      res.locals.currentURL = req.originalUrl;
      res.locals.adminType = req.session.user_type;

      res.locals.sessionSteamId = req.session.passport ? req.session.passport.user.id : null;
      res.locals.steamName = req.session.passport ? req.session.passport.user.displayName : null;
      next();
    } catch (e) {
      next(e);
    }
  });

  // First-boot wizard (self-gates with 404 once setup is complete).
  // Registered after the safe locals middleware so its 404 page can render.
  registerInstallRoutes(app);

  require("./app/routes/router.js")(app);
  app.use(notFoundMiddleware.notFound);
  app.use(require('./app/middleWares/errorHandler'));

  return app;
}

function startServer(app) {
  // set port, listen for requests
  const PORT = process.env.PORT || config.serverPort;
  app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}.`);
  });
}

// Only boot when executed directly — importing this module (e.g. tests
// calling createApp()) must not open ports or touch the database.
if (require.main === module) {
  let setupCompleteAtBoot = false;
  try { setupCompleteAtBoot = config.isSetupComplete(); } catch (e) { setupCompleteAtBoot = false; }
  if (setupCompleteAtBoot) {
    // Start the server after db bootstrapping
    dbBootstrap().then(() => {
      startServer(createApp());
    }).catch((error) => {
      logger.error("Error while doing database bootstrapping Error:", error);
      process.exit(1);
    });
  } else {
    logger.info('Setup incomplete — serving the /install wizard.');
    startServer(createApp());
  }
}

// ========== process error handling [ start ] ==========
process.on('uncaughtException', err => {
  logger.error("'uncaughtException' occurred! \n error:", err);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', reason.stack || reason);
});
// ========== process error handling [ end ] ==========

module.exports = { createApp, installGate };
