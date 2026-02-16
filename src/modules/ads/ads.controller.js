const adsService = require('./ads.service');

async function getProfiles(req, res, next) {
  try {
    const profiles = await adsService.getProfiles();
    res.json(profiles);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getProfiles,
};
