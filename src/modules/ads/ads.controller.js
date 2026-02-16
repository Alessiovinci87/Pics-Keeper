const AdsService = require('./ads.service');
const logger = require('../../utils/logger');

const AdsController = {
  async connect(req, res, next) {
    try {
      const { accountId, refreshToken } = req.body;

      if (!accountId || !refreshToken) {
        return res.status(400).json({
          error: 'accountId and refreshToken are required',
        });
      }

      if (typeof accountId !== 'number' || typeof refreshToken !== 'string') {
        return res.status(400).json({
          error: 'accountId must be a number and refreshToken must be a string',
        });
      }

      const result = await AdsService.connectAccount(accountId, refreshToken);

      res.json({
        success: true,
        profiles: result.profiles,
      });
    } catch (err) {
      next(err);
    }
  },
};

module.exports = AdsController;
