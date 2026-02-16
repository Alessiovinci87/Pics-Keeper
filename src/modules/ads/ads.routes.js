const { Router } = require('express');

const router = Router();

router.get('/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  return res.json({
    message: 'Authorization code received',
    code,
  });
});

module.exports = router;
