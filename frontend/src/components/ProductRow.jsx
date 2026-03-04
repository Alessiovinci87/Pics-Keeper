import { useState } from 'react';
import MarketplaceBreakdown from './MarketplaceBreakdown';
import { formatCurrency, formatNumber, formatPct, profitColorClass } from '../utils/format';

export default function ProductRow({ product, index }) {
  const [expanded, setExpanded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const p = product;

  return (
    <>
      <tr
        className={`product-row ${expanded ? 'expanded' : ''}`}
        onClick={() => setExpanded(!expanded)}
      >
        {/* # */}
        <td className="col-index">{index + 1}</td>

        {/* Product info */}
        <td className="col-product">
          <div className="product-info">
            <div className="product-image-wrap">
              {p.image_url && !imgError ? (
                <img src={p.image_url} alt={p.product_title} className="product-image" onError={() => setImgError(true)} />
              ) : (
                <div className="product-image-placeholder" />
              )}
            </div>
            <div className="product-details">
              <span className="product-title" title={p.product_title}>
                {p.product_title}
              </span>
              <div className="product-meta">
                <span className="product-asin">{p.asin}</span>
                {p.sku && <span className="product-sku">{p.sku}</span>}
              </div>
            </div>
          </div>
        </td>

        {/* Sales / Revenue */}
        <td className="col-number col-revenue">
          <span className="cell-main">{formatCurrency(p.revenue)}</span>
        </td>

        {/* Units */}
        <td className="col-number col-units">
          <span className="cell-main">{formatNumber(p.units_sold)}</span>
          <span className="cell-sub">{formatNumber(p.orders_count)} ord.</span>
        </td>

        {/* Amazon Fees */}
        <td className="col-number col-fees">
          <span className="cell-main negative">{formatCurrency(p.total_amazon_fees)}</span>
        </td>

        {/* PPC / Ads */}
        <td className="col-number col-ads">
          <span className="cell-main negative">{formatCurrency(p.ads_spend)}</span>
          <span className="cell-sub">TACOS {formatPct(p.tacos_pct)}</span>
        </td>

        {/* Product Costs */}
        <td className="col-number col-costs">
          <span className="cell-main negative">{formatCurrency(p.total_product_costs)}</span>
        </td>

        {/* Refunds */}
        <td className="col-number col-refunds">
          <span className="cell-main negative">{formatCurrency(p.refunds)}</span>
        </td>

        {/* Profit */}
        <td className={`col-number col-profit ${profitColorClass(p.net_profit)}`}>
          <span className="cell-main">{formatCurrency(p.net_profit)}</span>
        </td>

        {/* Margin */}
        <td className={`col-number col-margin ${profitColorClass(p.margin_pct)}`}>
          <span className="cell-main">{formatPct(p.margin_pct)}</span>
        </td>

        {/* ROI */}
        <td className={`col-number col-roi ${profitColorClass(p.roi_pct)}`}>
          <span className="cell-main">{formatPct(p.roi_pct)}</span>
        </td>

        {/* Expand arrow */}
        <td className="col-expand">
          <span className={`expand-arrow ${expanded ? 'open' : ''}`}>&#9660;</span>
        </td>
      </tr>

      {/* Marketplace breakdown (country dropdown) */}
      {expanded && (
        <tr className="marketplace-breakdown-row">
          <td colSpan="12">
            <MarketplaceBreakdown marketplaces={p.marketplaces} />
          </td>
        </tr>
      )}
    </>
  );
}
