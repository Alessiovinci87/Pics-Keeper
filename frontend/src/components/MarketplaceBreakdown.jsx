import { COUNTRY_FLAGS } from '../data/mockProducts';
import { formatCurrency, formatNumber, formatPct, profitColorClass } from '../utils/format';

export default function MarketplaceBreakdown({ marketplaces }) {
  if (!marketplaces || marketplaces.length === 0) {
    return <div className="no-marketplace-data">Nessun dato per marketplace disponibile</div>;
  }

  return (
    <div className="marketplace-breakdown">
      <table className="breakdown-table">
        <thead>
          <tr>
            <th className="col-country">Marketplace</th>
            <th className="col-number">Vendite</th>
            <th className="col-number">Unità</th>
            <th className="col-number">Commissioni AMZ</th>
            <th className="col-number">PPC</th>
            <th className="col-number">Costi Prodotto</th>
            <th className="col-number">Resi</th>
            <th className="col-number">Profitto</th>
            <th className="col-number">Margine</th>
            <th className="col-number">ROI</th>
          </tr>
        </thead>
        <tbody>
          {marketplaces.map((mp) => (
            <tr key={mp.country_code} className="marketplace-row">
              <td className="col-country">
                <span className="country-flag">{COUNTRY_FLAGS[mp.country_code] || '🏳️'}</span>
                <span className="country-name">{mp.marketplace_name}</span>
                <span className="country-currency">({mp.currency})</span>
              </td>
              <td className="col-number">{formatCurrency(mp.revenue)}</td>
              <td className="col-number">
                <span>{formatNumber(mp.units_sold)}</span>
                <span className="cell-sub">{formatNumber(mp.orders_count)} ord.</span>
              </td>
              <td className="col-number negative">{formatCurrency(mp.total_amazon_fees)}</td>
              <td className="col-number negative">
                <span>{formatCurrency(mp.ads_spend)}</span>
                <span className="cell-sub">TACOS {formatPct(mp.tacos_pct)}</span>
              </td>
              <td className="col-number negative">{formatCurrency(mp.total_product_costs)}</td>
              <td className="col-number negative">{formatCurrency(mp.refunds)}</td>
              <td className={`col-number ${profitColorClass(mp.net_profit)}`}>
                {formatCurrency(mp.net_profit)}
              </td>
              <td className={`col-number ${profitColorClass(mp.margin_pct)}`}>
                {formatPct(mp.margin_pct)}
              </td>
              <td className={`col-number ${profitColorClass(mp.roi_pct)}`}>
                {formatPct(mp.roi_pct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
