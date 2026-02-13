const { Router } = require('express');
const OrdersService = require('../modules/orders/orders.service');
const ProfitService = require('../modules/profit-engine/profit.service');
const validate = require('../middleware/validate');

const router = Router();

/**
 * GET /api/order/:orderId
 * Get order detail with profit breakdown.
 * Query params: accountId
 */
router.get('/:orderId', validate({ query: ['accountId'], params: ['orderId'] }), async (req, res, next) => {
  try {
    const accountId = parseInt(req.query.accountId, 10);
    const orderId = req.params.orderId;

    // Get order items with profit data
    const items = await OrdersService.getOrderDetail(accountId, orderId);

    if (items.length === 0) {
      return res.status(404).json({ error: { message: 'Order not found' } });
    }

    // Calculate order-level totals
    const totals = items.reduce((acc, item) => {
      acc.revenue += parseFloat(item.revenue || 0);
      acc.totalCosts += parseFloat(item.total_costs || 0);
      acc.netProfit += parseFloat(item.net_profit || 0);
      acc.referralFee += parseFloat(item.referral_fee || 0);
      acc.fbaFee += parseFloat(item.fba_fee || 0);
      acc.adsAllocated += parseFloat(item.ads_allocated || 0);
      acc.productCost += parseFloat(item.product_cost || 0);
      acc.refundAmount += parseFloat(item.refund_amount || 0);
      acc.quantity += parseInt(item.quantity || 0, 10);
      return acc;
    }, {
      revenue: 0, totalCosts: 0, netProfit: 0, referralFee: 0,
      fbaFee: 0, adsAllocated: 0, productCost: 0, refundAmount: 0, quantity: 0,
    });

    res.json({
      data: {
        orderId,
        items,
        totals,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
