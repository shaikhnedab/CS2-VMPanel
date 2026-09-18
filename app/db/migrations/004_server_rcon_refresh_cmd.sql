-- CS2-VMPanel migration 004 — per-server RCON refresh command.
-- Classic servers refresh VIPs with `sm_vipRefresh`; CS2 servers behind the
-- cs2-fake-rcon bridge need e.g. `fake_rcon css_viprefresh`. NULL means
-- "use the legacy default" so existing rows behave exactly as before.
-- Single portable statement; the runner tolerates already-exists errors and
-- schema_migrations keeps it run-once.

ALTER TABLE `tbl_servers` ADD COLUMN `rcon_refresh_cmd` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL;
