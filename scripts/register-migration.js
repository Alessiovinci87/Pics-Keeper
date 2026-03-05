const { pool } = require('../src/database/pool');

async function main() {
  await pool.query(
    "INSERT INTO _migrations (name) VALUES ('002_business_report_daily.sql') ON CONFLICT DO NOTHING"
  );
  console.log('Migration 002 registered as executed.');
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
