/**
 * Mock product data matching the backend /api/dashboard/products schema.
 * Each product has aggregated totals + per-marketplace breakdown.
 */

export const COUNTRY_FLAGS = {
  DE: '\uD83C\uDDE9\uD83C\uDDEA', FR: '\uD83C\uDDEB\uD83C\uDDF7', IT: '\uD83C\uDDEE\uD83C\uDDF9', ES: '\uD83C\uDDEA\uD83C\uDDF8', GB: '\uD83C\uDDEC\uD83C\uDDE7',
  NL: '\uD83C\uDDF3\uD83C\uDDF1', SE: '\uD83C\uDDF8\uD83C\uDDEA', PL: '\uD83C\uDDF5\uD83C\uDDF1', TR: '\uD83C\uDDF9\uD83C\uDDF7', BE: '\uD83C\uDDE7\uD83C\uDDEA',
  US: '\uD83C\uDDFA\uD83C\uDDF8', CA: '\uD83C\uDDE8\uD83C\uDDE6',
};

export const COUNTRY_NAMES = {
  DE: 'Germania', FR: 'Francia', IT: 'Italia', ES: 'Spagna', GB: 'Regno Unito',
  NL: 'Paesi Bassi', SE: 'Svezia', PL: 'Polonia', TR: 'Turchia', BE: 'Belgio',
  US: 'Stati Uniti', CA: 'Canada',
};

export const MARKETPLACE_NAMES = {
  DE: 'Amazon.de', FR: 'Amazon.fr', IT: 'Amazon.it', ES: 'Amazon.es', GB: 'Amazon.co.uk',
  NL: 'Amazon.nl', SE: 'Amazon.se', PL: 'Amazon.pl', TR: 'Amazon.com.tr', BE: 'Amazon.com.be',
  US: 'Amazon.com', CA: 'Amazon.ca',
};

export const CURRENCIES = {
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', GB: 'GBP',
  NL: 'EUR', SE: 'SEK', PL: 'PLN', TR: 'TRY', BE: 'EUR',
  US: 'USD', CA: 'CAD',
};
