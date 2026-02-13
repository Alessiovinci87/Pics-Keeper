const ProfitService = require('./modules/profit-engine/profit.service');

(async () => {
  try {
    const result = await ProfitService.computeForRange(
      1,
      1,
      '2026-02-13 00:00:00',
      '2026-02-14 00:00:00'
    );
    console.log(result);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
