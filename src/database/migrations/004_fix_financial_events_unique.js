/**
 * Fix: financial_events_raw unique constraint doesn't match ON CONFLICT
 * when amazon_order_id or fee_type are NULL (PostgreSQL treats NULLs as distinct).
 * Replace with NULLS NOT DISTINCT to allow ON CONFLICT to work with NULL values.
 *
 * Written as JS because node-pg hangs on multi-statement SQL with DO $$ blocks.
 */
exports.up = async function up(client) {
  // Step 1: Drop ALL existing unique constraints on the table
  const { rows } = await client.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'financial_events_raw'::regclass AND contype = 'u'
  `);
  for (const row of rows) {
    console.log(`  Dropping constraint: ${row.conname}`);
    await client.query(`ALTER TABLE financial_events_raw DROP CONSTRAINT ${row.conname}`);
  }
  console.log(`  Dropped ${rows.length} constraint(s).`);

  // Step 2: Remove duplicate rows keeping only the row with the highest id per group
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

  // Step 3: Recreate with NULLS NOT DISTINCT so ON CONFLICT works with NULL values
  await client.query(`
    ALTER TABLE financial_events_raw
      ADD CONSTRAINT financial_events_raw_unique_event
      UNIQUE NULLS NOT DISTINCT (account_id, amazon_order_id, event_type, fee_type, event_date)
  `);
  console.log('  Unique constraint created with NULLS NOT DISTINCT.');
};
