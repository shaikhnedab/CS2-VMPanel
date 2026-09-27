-- CS2-VMPanel migration 005 — sale grant tracking
--
-- A sale row records that money was captured; it says nothing about whether
-- the VIP was actually granted. When the grant step failed after the insert,
-- support had no way to tell "paid and delivered" from "paid and lost" except
-- by cross-referencing every sv_* table by hand. grant_status closes that gap:
-- every insert starts at 'pending', settlement moves it to 'granted' or
-- 'failed' (with the reason in grant_error), and the audit tool reports the
-- difference.
--
-- One statement per ALTER on purpose (see migration 001): a multi-clause ALTER
-- is all-or-nothing, so on a half-migrated table the runner would record the
-- file as done with a column permanently absent.
ALTER TABLE `tbl_sales`
  ADD COLUMN `grant_status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending' AFTER `is_gift`;
ALTER TABLE `tbl_sales`
  ADD COLUMN `grant_error` varchar(255) COLLATE utf8mb4_unicode_ci NULL AFTER `grant_status`;
CREATE INDEX `ix_tbl_sales_grant` ON `tbl_sales` (`grant_status`);

-- ================= DOWN (rollback, run manually) =================
-- DROP INDEX `ix_tbl_sales_grant` ON `tbl_sales`;
-- ALTER TABLE `tbl_sales` DROP COLUMN `grant_error`;
-- ALTER TABLE `tbl_sales` DROP COLUMN `grant_status`;
