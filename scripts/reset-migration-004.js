const db = require('../src/database/pool');

async function main() {
  await db.query("DELETE FROM _migrations WHERE name LIKE '004_fix_financial_events_unique%'");
  console.log('Migration 004 reset. You can now re-run: node src/database/migrate.js');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
