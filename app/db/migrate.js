// Migration runner: applies every .sql file in app/db/migrations in order,
// tracking applied files in the schema_migrations table. Safe to re-run.
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db_bridge');
const logger = require('../modules/logger')('Migrate');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATIONS_TABLE = 'schema_migrations';

(async () => {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      filename VARCHAR(120) NOT NULL UNIQUE,
      applied_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const rows = await db.query(`SELECT filename FROM ${MIGRATIONS_TABLE}`);
    const applied = new Set(rows.map((r) => r.filename));

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      logger.info(`Applying ${file}...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

      // Strip SQL comments (-- and /* */) and split on statement boundaries.
      const cleaned = sql
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^--.*$/gm, '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const stmt of cleaned) {
        await db.query(stmt);
      }
      await db.query(db.queryFormat(`INSERT INTO ${MIGRATIONS_TABLE} (filename, applied_at) VALUES (?, NOW())`, [file]));
      ran++;
    }
    logger.info(`Migrate complete. Applied ${ran} new migration(s).`);
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed:', error && (error.stack || error));
    process.exit(1);
  }
})();