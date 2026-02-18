const { Router } = require('express');
const AccountService = require('./account.service');

const router = Router();

// GET /api/accounts
router.get('/', async (req, res, next) => {
  try {
    const accounts = await AccountService.list({
      activeOnly: req.query.active !== 'false',
    });
    res.json({ data: accounts });
  } catch (err) {
    next(err);
  }
});

// GET /api/accounts/:id
router.get('/:id', async (req, res, next) => {
  try {
    const account = await AccountService.getById(parseInt(req.params.id, 10));
    res.json({ data: account });
  } catch (err) {
    next(err);
  }
});

// POST /api/accounts
router.post('/', async (req, res, next) => {
  try {
    const account = await AccountService.create(req.body);
    res.status(201).json({ data: account });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/accounts/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const account = await AccountService.update(parseInt(req.params.id, 10), req.body);
    res.json({ data: account });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/accounts/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await AccountService.remove(parseInt(req.params.id, 10));
    res.json({ message: 'Account deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
