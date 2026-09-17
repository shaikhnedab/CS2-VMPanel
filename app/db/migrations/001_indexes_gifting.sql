-- CS2-VMPanel migration 001 — indexes, uniqueness, gifting columns
-- Apply: mysql -u USER -p DBNAME < 001_indexes_gifting.sql
-- Reversible: see DOWN section at bottom (commented).
--
-- NOTE: plain CREATE INDEX / ADD COLUMN on purpose. `IF NOT EXISTS` for
-- these statements is MariaDB-only and a syntax error on MySQL. Run-once
-- safety comes from the schema_migrations tracking table, and the migration
-- runner tolerates already-exists errors (ER_DUP_KEYNAME / ER_DUP_FIELDNAME)
-- so partial applies converge on both MySQL and MariaDB.

-- Uniqueness / lookup indexes
CREATE UNIQUE INDEX `ux_tbl_users_username` ON `tbl_users` (`username`);
CREATE UNIQUE INDEX `ux_tbl_settings_key` ON `tbl_settings` (`setting_key`);
CREATE UNIQUE INDEX `ux_tbl_servers_tblname` ON `tbl_servers` (`tbl_name`);
CREATE UNIQUE INDEX `ux_tbl_sales_order` ON `tbl_sales` (`order_id`);
CREATE INDEX `ix_tbl_sales_steam_created` ON `tbl_sales` (`payer_steamid`, `created_on`);
CREATE INDEX `ix_tbl_sales_type` ON `tbl_sales` (`sale_type`);
CREATE INDEX `ix_tbl_audit_created` ON `tbl_audit_logs` (`created_at`);
CREATE INDEX `ix_tbl_bundles_rel` ON `tbl_rel_bundle_server` (`bundle_id`, `server_id`);

-- Gifting support (sale_type 3 = gift)
ALTER TABLE `tbl_sales`
  ADD COLUMN `recipient_steamid` varchar(150) COLLATE utf8mb4_unicode_ci NULL AFTER `payer_steamid`,
  ADD COLUMN `is_gift` tinyint(4) NOT NULL DEFAULT 0 AFTER `sale_type`;
CREATE INDEX `ix_tbl_sales_recipient` ON `tbl_sales` (`recipient_steamid`);

-- Per-server VIP tables: these names are dynamic (sv_*). Run for each game-server table:
--   CREATE INDEX `ix_<tbl>_type_expire` ON `<tbl>` (`type`, `expireStamp`);
-- Example:
--   CREATE INDEX `ix_sv_server1_type_expire` ON `sv_server1` (`type`, `expireStamp`);

-- ================= DOWN (rollback, run manually) =================
-- ALTER TABLE `tbl_sales` DROP COLUMN `recipient_steamid`, DROP COLUMN `is_gift`;
-- DROP INDEX `ux_tbl_users_username` ON `tbl_users`;
-- DROP INDEX `ux_tbl_settings_key` ON `tbl_settings`;
-- DROP INDEX `ux_tbl_servers_tblname` ON `tbl_servers`;
-- DROP INDEX `ux_tbl_sales_order` ON `tbl_sales`;
-- DROP INDEX `ix_tbl_sales_steam_created` ON `tbl_sales`;
-- DROP INDEX `ix_tbl_sales_type` ON `tbl_sales`;
-- DROP INDEX `ix_tbl_sales_recipient` ON `tbl_sales`;
