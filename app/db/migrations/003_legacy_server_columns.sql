-- CS2-VMPanel migration 003 — backfill columns the panel expects on tbl_servers.
-- Legacy or hand-created databases can have a tbl_servers TABLE that predates
-- some columns (bootstrap only CREATEs missing tables, never missing columns),
-- which surfaces as `Unknown column '...' in 'field list'` on server pages.
--
-- One single-column ALTER per statement on purpose: the runner tolerates an
-- already-exists error per statement and continues, so each missing column is
-- added independently. Plain ADD COLUMN (MySQL has no ADD COLUMN IF NOT EXISTS).
-- All columns are nullable with DEFAULT NULL, so this is safe on non-empty
-- tables even in strict SQL mode. Types match the bootstrap schema verbatim.

ALTER TABLE `tbl_servers` ADD COLUMN `server_ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL;
ALTER TABLE `tbl_servers` ADD COLUMN `server_port` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL;
ALTER TABLE `tbl_servers` ADD COLUMN `server_rcon_pass` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL;
ALTER TABLE `tbl_servers` ADD COLUMN `vip_slots` int(20) DEFAULT NULL;
ALTER TABLE `tbl_servers` ADD COLUMN `vip_price` int(20) DEFAULT NULL;
ALTER TABLE `tbl_servers` ADD COLUMN `vip_currency` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL;
ALTER TABLE `tbl_servers` ADD COLUMN `vip_flag` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL;
ALTER TABLE `tbl_servers` ADD COLUMN `vip_days` int(20) DEFAULT NULL;
ALTER TABLE `tbl_servers` ADD COLUMN `created_at` datetime DEFAULT NULL;
