const db = require('../../database/pool');
const logger = require('../../utils/logger');
const { ValidationError, NotFoundError } = require('../../utils/errors');

/**
 * ASIN Costs Service - manages per-marketplace product costs.
 * Supports cost history via effective_from dates.
 */
const AsinCostsService = {
  /**
   * Set costs for an ASIN on a specific marketplace.
   * Creates a new cost record with the given effective_from date.
   */
  async setCosts({ accountId, asin, marketplaceId, costs, effectiveFrom, currency }) {
    if (!asin || !marketplaceId) {
      throw new ValidationError('asin and marketplaceId are required');
    }

    const result = await db.query(
      `INSERT INTO asin_costs (
        account_id, asin, marketplace_id,
        product_cost, inbound_cost, customs_cost, prep_cost, packaging_cost,
        storage_monthly_cost, currency, effective_from
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (account_id, asin, marketplace_id, effective_from) DO UPDATE SET
        product_cost = EXCLUDED.product_cost,
        inbound_cost = EXCLUDED.inbound_cost,
        customs_cost = EXCLUDED.customs_cost,
        prep_cost = EXCLUDED.prep_cost,
        packaging_cost = EXCLUDED.packaging_cost,
        storage_monthly_cost = EXCLUDED.storage_monthly_cost,
        currency = EXCLUDED.currency,
        updated_at = NOW()
      RETURNING *`,
      [
        accountId, asin, marketplaceId,
        costs.productCost || 0,
        costs.inboundCost || 0,
        costs.customsCost || 0,
        costs.prepCost || 0,
        costs.packagingCost || 0,
        costs.storageMonthly || 0,
        currency || 'EUR',
        effectiveFrom || new Date().toISOString().split('T')[0],
      ]
    );

    logger.info('ASIN costs updated', { accountId, asin, marketplaceId });
    return result.rows[0];
  },

  /**
   * Get current costs for an ASIN (latest effective_from).
   */
  async getCurrent(accountId, asin, marketplaceId) {
    const result = await db.query(
      `SELECT * FROM asin_costs
       WHERE account_id = $1 AND asin = $2 AND marketplace_id = $3
       ORDER BY effective_from DESC
       LIMIT 1`,
      [accountId, asin, marketplaceId]
    );

    if (result.rows.length === 0) return null;
    return result.rows[0];
  },

  /**
   * Get cost history for an ASIN.
   */
  async getHistory(accountId, asin, marketplaceId) {
    const result = await db.query(
      `SELECT ac.*, m.country_code, m.name AS marketplace_name
       FROM asin_costs ac
       LEFT JOIN marketplaces m ON m.id = ac.marketplace_id
       WHERE ac.account_id = $1 AND ac.asin = $2
         AND ($3::integer IS NULL OR ac.marketplace_id = $3)
       ORDER BY ac.effective_from DESC`,
      [accountId, asin, marketplaceId || null]
    );
    return result.rows;
  },

  /**
   * List all ASIN costs for an account (latest per ASIN+marketplace).
   */
  async listAll(accountId, { marketplaceId, page = 1, limit = 100 } = {}) {
    const conditions = ['ac.account_id = $1'];
    const params = [accountId];
    let idx = 2;

    if (marketplaceId) {
      conditions.push(`ac.marketplace_id = $${idx}`);
      params.push(marketplaceId);
      idx++;
    }

    const offset = (page - 1) * limit;

    const result = await db.query(
      `SELECT DISTINCT ON (ac.asin, ac.marketplace_id)
        ac.*, m.country_code, m.name AS marketplace_name,
        a.title AS asin_title
       FROM asin_costs ac
       LEFT JOIN marketplaces m ON m.id = ac.marketplace_id
       LEFT JOIN asins a ON a.account_id = ac.account_id AND a.asin = ac.asin
       WHERE ${conditions.join(' AND ')}
       ORDER BY ac.asin, ac.marketplace_id, ac.effective_from DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    return result.rows;
  },

  /**
   * Bulk import costs (e.g., from CSV upload).
   */
  async bulkImport(accountId, rows) {
    let imported = 0;

    await db.transaction(async (client) => {
      for (const row of rows) {
        await client.query(
          `INSERT INTO asin_costs (
            account_id, asin, marketplace_id,
            product_cost, inbound_cost, customs_cost, prep_cost, packaging_cost,
            storage_monthly_cost, currency, effective_from
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (account_id, asin, marketplace_id, effective_from) DO UPDATE SET
            product_cost = EXCLUDED.product_cost,
            inbound_cost = EXCLUDED.inbound_cost,
            customs_cost = EXCLUDED.customs_cost,
            prep_cost = EXCLUDED.prep_cost,
            packaging_cost = EXCLUDED.packaging_cost,
            storage_monthly_cost = EXCLUDED.storage_monthly_cost,
            updated_at = NOW()`,
          [
            accountId,
            row.asin,
            row.marketplaceId,
            row.productCost || 0,
            row.inboundCost || 0,
            row.customsCost || 0,
            row.prepCost || 0,
            row.packagingCost || 0,
            row.storageMonthly || 0,
            row.currency || 'EUR',
            row.effectiveFrom || new Date().toISOString().split('T')[0],
          ]
        );
        imported++;
      }
    });

    logger.info('ASIN costs bulk imported', { accountId, imported });
    return { imported };
  },
};

module.exports = AsinCostsService;
