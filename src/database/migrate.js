/**
 * Simple migration runner.
 * Usage:
 *   node src/database/migrate.js          - run all pending migrations
 *   node src/database/migrate.js down      - rollback (drops all tables)
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');
const logger = require('../utils/logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getExecutedMigrations() {
  const result = await pool.query('SELECT name FROM _migrations ORDER BY id');
  return result.rows.map((r) => r.name);
}

async function runMigrations() {
  await ensureMigrationsTable();
  const executed = await getExecutedMigrations();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (executed.includes(file)) {
      logger.info(`Migration already executed: ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    logger.info(`Running migration: ${file}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info(`Migration completed: ${file}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`Migration failed: ${file}`, { error: err.message });
      throw err;
    } finally {
      client.release();
    }
  }

  logger.info(`Migrations complete. ${count} new migration(s) applied.`);
}

async function rollback() {
  logger.warn('Rolling back: dropping all application tables');
  const tables = [
    'alert_thresholds', 'sync_log', 'alerts', 'payout_reconciliation',
    'account_daily_kpi', 'asin_daily_metrics', 'order_profit',
    'ads_daily_spend', 'financial_events_raw', 'orders_raw',
    'asin_costs', 'asins', 'account_marketplaces', 'marketplaces', 'accounts',
    '_migrations',
  ];

  for (const table of tables) {
    await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    logger.info(`Dropped table: ${table}`);
  }

  // Drop custom types
  await pool.query('DROP TYPE IF EXISTS sync_status CASCADE');
  await pool.query('DROP TYPE IF EXISTS alert_severity CASCADE');
  await pool.query('DROP TYPE IF EXISTS alert_status CASCADE');

  logger.info('Rollback complete');
}

async function main() {
  try {
    const command = process.argv[2];
    if (command === 'down') {
      await rollback();
    } else {
      await runMigrations();
    }
  } catch (err) {
    logger.error('Migration error', { error: err.message });
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
