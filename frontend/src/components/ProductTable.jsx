import ProductRow from './ProductRow';

export default function ProductTable({ products }) {
  if (!products || products.length === 0) {
    return (
      <div className="empty-state">
        <p>Nessun prodotto trovato per il periodo selezionato.</p>
      </div>
    );
  }

  return (
    <div className="product-table-wrapper">
      <table className="product-table">
        <thead>
          <tr>
            <th className="col-index">#</th>
            <th className="col-product">Prodotto</th>
            <th className="col-number col-revenue">Vendite</th>
            <th className="col-number col-units">Unità</th>
            <th className="col-number col-fees">Commissioni AMZ</th>
            <th className="col-number col-ads">PPC</th>
            <th className="col-number col-costs">Costi Prodotto</th>
            <th className="col-number col-refunds">Resi</th>
            <th className="col-number col-profit">Profitto</th>
            <th className="col-number col-margin">Margine</th>
            <th className="col-number col-roi">ROI</th>
            <th className="col-expand"></th>
          </tr>
        </thead>
        <tbody>
          {products.map((product, idx) => (
            <ProductRow key={product.asin} product={product} index={idx} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
