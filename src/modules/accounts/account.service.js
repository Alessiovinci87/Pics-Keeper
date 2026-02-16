const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { NotFoundError, ValidationError } = require('../../utils/errors');

/**
 * Account Service - manages seller accounts and their marketplace associations.
 */
const AccountService = {
  /**
   * List all accounts (with optional active filter).
   */
  async list({ activeOnly = true } = {}) {
    const where = activeOnly ? 'WHERE a.is_active = TRUE' : '';
    const result = await db.query(`
      SELECT a.*,
        COALESCE(
          json_agg(
            json_build_object(
              'marketplace_id', m.marketplace_id,
              'country_code', m.country_code,
              'name', m.name,
              'is_active', am.is_active,
              'last_orders_sync_at', am.last_orders_sync_at,
              'last_financial_sync_at', am.last_financial_sync_at,
              'last_ads_sync_at', am.last_ads_sync_at,
              'sync_status', am.sync_status,
              'ads_sync_enabled', am.ads_sync_enabled
            )
          ) FILTER (WHERE m.id IS NOT NULL),
          '[]'
        ) AS marketplaces
      FROM accounts a
      LEFT JOIN account_marketplaces am ON am.account_id = a.id
      LEFT JOIN marketplaces m ON m.id = am.marketplace_id
      ${where}
      GROUP BY a.id
      ORDER BY a.created_at
    `);
    return result.rows;
  },

  /**
   * Get single account by ID.
   */
  async getById(id) {
    const result = await db.query(
      `SELECT * FROM accounts WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) throw new NotFoundError('Account');
    return result.rows[0];
  },

  /**
   * Create a new account and link to marketplaces.
   */
  async create({ name, sellerId, spApiRefreshToken, adsApiRefreshToken, marketplaceIds = [] }) {
    if (!name || !sellerId) {
      throw new ValidationError('name and sellerId are required');
    }

    return db.transaction(async (client) => {
      const accountResult = await client.query(
        `INSERT INTO accounts (name, seller_id, sp_api_refresh_token, ads_api_refresh_token)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [name, sellerId, spApiRefreshToken || null, adsApiRefreshToken || null]
      );
      const account = accountResult.rows[0];

      if (marketplaceIds.length > 0) {
        const values = marketplaceIds
          .map((_, i) => `($1, $${i + 2})`)
          .join(', ');
        await client.query(
          `INSERT INTO account_marketplaces (account_id, marketplace_id)
           VALUES ${values}
           ON CONFLICT (account_id, marketplace_id) DO NOTHING`,
          [account.id, ...marketplaceIds]
        );
      }

      logger.info('Account created', { accountId: account.id, sellerId });
      return account;
    });
  },

  /**
   * Update account details.
   */
  async update(id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;

    const allowedFields = ['name', 'sp_api_refresh_token', 'ads_api_refresh_token', 'ads_profile_ids', 'is_active'];
    for (const [key, value] of Object.entries(updates)) {
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase(); // camelCase -> snake_case
      if (allowedFields.includes(dbKey)) {
        fields.push(`${dbKey} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    if (fields.length === 0) throw new ValidationError('No valid fields to update');

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await db.query(
      `UPDATE accounts SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) throw new NotFoundError('Account');
    return result.rows[0];
  },

  /**
   * Get all active account+marketplace combos for sync jobs.
   */
  async getActiveSyncTargets() {
    const result = await db.query(`
      SELECT
        a.id AS account_id,
        a.seller_id,
        a.sp_api_refresh_token,
        a.ads_api_refresh_token,
        a.ads_profile_ids,
        am.marketplace_id AS account_marketplace_id,
        m.marketplace_id AS amazon_marketplace_id,
        m.country_code,
        m.region,
        m.currency,
        am.last_orders_sync_at,
        am.last_financial_sync_at,
        am.last_ads_sync_at,
        am.ads_sync_enabled
      FROM accounts a
      JOIN account_marketplaces am ON am.account_id = a.id AND am.is_active = TRUE
      JOIN marketplaces m ON m.id = am.marketplace_id
      WHERE a.is_active = TRUE
      ORDER BY a.id, m.id
    `);
    return result.rows;
  },

  /**
   * Get active account+marketplace combos that have ads sync enabled.
   */
  async getAdsSyncTargets() {
    const result = await db.query(`
      SELECT
        a.id AS account_id,
        a.seller_id,
        a.ads_api_refresh_token,
        a.ads_profile_ids,
        am.marketplace_id AS account_marketplace_id,
        m.marketplace_id AS amazon_marketplace_id,
        m.country_code,
        m.region,
        m.currency,
        am.last_ads_sync_at
      FROM accounts a
      JOIN account_marketplaces am ON am.account_id = a.id AND am.is_active = TRUE
      JOIN marketplaces m ON m.id = am.marketplace_id
      WHERE a.is_active = TRUE
        AND am.ads_sync_enabled = TRUE
        AND a.ads_api_refresh_token IS NOT NULL
      ORDER BY a.id, m.id
    `);
    return result.rows;
  },

  /**
   * Enable or disable ads sync for a specific account+marketplace.
   */
  async setAdsSyncEnabled(accountId, marketplaceId, enabled) {
    const result = await db.query(
      `UPDATE account_marketplaces
       SET ads_sync_enabled = $1
       WHERE account_id = $2 AND marketplace_id = $3
       RETURNING *`,
      [enabled, accountId, marketplaceId]
    );
    if (result.rows.length === 0) throw new NotFoundError('Account marketplace');
    return result.rows[0];
  },

  /**
   * Update last sync timestamp for a specific sync type.
   */
  async updateSyncTimestamp(accountId, marketplaceId, syncType, timestamp) {
    const column = {
      orders: 'last_orders_sync_at',
      financial: 'last_financial_sync_at',
      ads: 'last_ads_sync_at',
    }[syncType];

    if (!column) return;

    await db.query(
      `UPDATE account_marketplaces
       SET ${column} = $1, sync_status = 'idle'
       WHERE account_id = $2 AND marketplace_id = $3`,
      [timestamp, accountId, marketplaceId]
    );
  },

  /**
   * Mark sync as running or failed.
   */
  async setSyncStatus(accountId, marketplaceId, status) {
    await db.query(
      `UPDATE account_marketplaces SET sync_status = $1
       WHERE account_id = $2 AND marketplace_id = $3`,
      [status, accountId, marketplaceId]
    );
  },
};

module.exports = AccountService;
