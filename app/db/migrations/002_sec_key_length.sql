-- 002: widen tbl_users.sec_key for 64-char hex session keys.
-- Random session keys (crypto.randomBytes(32)) are 64 chars; the original
-- schema allowed 45, so creating panel admins failed with ER_DATA_TOO_LONG.
ALTER TABLE `tbl_users` MODIFY `sec_key` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL;
