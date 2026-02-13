const db = require('../database/pool');

/**
 * Sync Logger - records sync operations for auditing and monitoring.
 */
const SyncLogger = {
  /**
   * Log the start of a sync operation.
   */
  async start(accountId, marketplaceId, syncType) {
    const result = await db.query(
      `INSERT INTO sync_log (account_id, marketplace_id, sync_type, status)
       VALUES ($1, $2, $3, 'started')
       RETURNING *`,
      [accountId, marketplaceId, syncType]
    );
    return result.rows[0];
  },

  /**
   * Mark sync as completed with stats.
   */
  async complete(syncLogId, { processed = 0, inserted = 0, updated = 0 } = {}) {
    await db.query(
      `UPDATE sync_log SET
        status = 'completed',
        records_processed = $2,
        records_inserted = $3,
        records_updated = $4,
        completed_at = NOW(),
        duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
      WHERE id = $1`,
      [syncLogId, processed, inserted, updated]
    );
  },

  /**
   * Mark sync as failed.
   */
  async fail(syncLogId, errorMessage) {
    await db.query(
      `UPDATE sync_log SET
        status = 'failed',
        error_message = $2,
        completed_at = NOW(),
        duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
      WHERE id = $1`,
      [syncLogId, errorMessage]
    );
  },

  /**
   * Get recent sync logs for monitoring.
   */
  async getRecent(accountId, limit = 50) {
    const result = await db.query(
      `SELECT sl.*, m.country_code
       FROM sync_log sl
       LEFT JOIN marketplaces m ON m.id = sl.marketplace_id
       WHERE sl.account_id = $1
       ORDER BY sl.started_at DESC
       LIMIT $2`,
      [accountId, limit]
    );
    return result.rows;
  },
};

module.exports = SyncLogger;
