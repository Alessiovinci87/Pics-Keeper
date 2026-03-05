/**
 * Run migration 004 step-by-step.
 * node-pg can hang when sending multi-statement SQL with DO $$ blocks,
 * so we execute each step individually.
 */
const { pool } = require('../src/database/pool');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Step 1: Drop all existing unique constraints
    console.log('Step 1: Dropping existing unique constraints...');
    const { rows } = await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'financial_events_raw'::regclass AND contype = 'u'
    `);
    for (const row of rows) {
      console.log(`  Dropping constraint: ${row.conname}`);
      await client.query(`ALTER TABLE financial_events_raw DROP CONSTRAINT ${row.conname}`);
    }
    console.log(`  Dropped ${rows.length} constraint(s).`);

    // Step 2: Count rows before dedup
    const before = await client.query('SELECT COUNT(*) AS cnt FROM financial_events_raw');
    console.log(`Step 2: Removing duplicates (${before.rows[0].cnt} rows total)...`);

    const delResult = await client.query(`
      DELETE FROM financial_events_raw a
      USING (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY account_id,
            COALESCE(amazon_order_id, ''),
            event_type,
            COALESCE(fee_type, ''),
            event_date
          ORDER BY id DESC
        ) AS rn
        FROM financial_events_raw
      ) b
      WHERE a.id = b.id AND b.rn > 1
    `);
    console.log(`  Deleted ${delResult.rowCount} duplicate row(s).`);

    // Step 3: Recreate unique constraint with NULLS NOT DISTINCT
    console.log('Step 3: Creating unique constraint with NULLS NOT DISTINCT...');
    await client.query(`
      ALTER TABLE financial_events_raw
        ADD CONSTRAINT financial_events_raw_unique_event
        UNIQUE NULLS NOT DISTINCT (account_id, amazon_order_id, event_type, fee_type, event_date)
    `);
    console.log('  Constraint created.');

    // Record migration as executed
    await client.query("INSERT INTO _migrations (name) VALUES ('004_fix_financial_events_unique.sql')");
    await client.query('COMMIT');
    console.log('Migration 004 completed successfully!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 004 failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(() => process.exit(1));
