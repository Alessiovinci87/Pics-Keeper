const { ValidationError } = require('../utils/errors');

/**
 * Middleware factory that validates request fields exist.
 * Usage: validate({ body: ['accountId', 'asin'], query: ['dateFrom'] })
 */
function validate(schema) {
  return (req, _res, next) => {
    const errors = [];

    if (schema.body) {
      for (const field of schema.body) {
        if (req.body[field] === undefined || req.body[field] === null || req.body[field] === '') {
          errors.push(`body.${field} is required`);
        }
      }
    }

    if (schema.query) {
      for (const field of schema.query) {
        if (!req.query[field]) {
          errors.push(`query.${field} is required`);
        }
      }
    }

    if (schema.params) {
      for (const field of schema.params) {
        if (!req.params[field]) {
          errors.push(`params.${field} is required`);
        }
      }
    }

    if (errors.length > 0) {
      return next(new ValidationError('Validation failed', errors));
    }

    next();
  };
}

module.exports = validate;
