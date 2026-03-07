const { getDb } = require("./database");
const { findProductByBarcode } = require("./products");

const USD_TO_LL = 90000;

function reduceStock(barcode, qty) {
  const db = getDb();
  db.prepare(
    `
    UPDATE products
    SET stock_quantity = stock_quantity - ?
    WHERE barcode = ?
  `
  ).run(qty, barcode);
}

function insertSale(data) {
  const db = getDb();

  db.prepare(
    `
    INSERT INTO sales (
      order_code,
      barcode,
      product_id,
      quantity,
      unit_price,
      cost,
      total_sale,
      profit
    )
    VALUES (?,?,?,?,?,?,?,?)
  `
  ).run(
    data.order_code,
    data.barcode,
    data.product_id,
    data.quantity,
    data.unit_price,
    data.cost,
    data.total_sale,
    data.profit
  );
}

function recordOrderItemsToSales(order) {
  const items = order.order_detail || [];

  for (const d of items) {
    const item = d.item || {};
    const barcode = item.barcode;
    if (!barcode) continue;

    const product = findProductByBarcode(barcode);
    if (!product) continue;

    const qty = Number(d.quantity || 0);
    const price = Number(d.item_price || 0);

    const total = qty * price;
    const cost = (product.cost_usd || 0) * qty;
    const profit = total - cost;

    insertSale({
      order_code: order.code,
      barcode,
      product_id: product.id,
      quantity: qty,
      unit_price: price,
      cost,
      total_sale: total,
      profit,
    });

    reduceStock(barcode, qty);
  }
}

function getSalesReport(opts = {}) {
  const db = getDb();
  const { from, to } = opts;

  const params = [];
  const where = [];

  if (from) {
    where.push("datetime(s.created_at) >= datetime(?)");
    params.push(from);
  }
  if (to) {
    where.push("datetime(s.created_at) <= datetime(?)");
    params.push(to);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `
    SELECT
      s.*,
      p.barcode AS product_barcode,
      p.item_name,
      p.brand,
      p.unit_price_usd AS product_unit_price_usd,
      p.cost_usd AS product_cost_usd
    FROM sales s
    LEFT JOIN products p ON s.product_id = p.id
    ${whereSql}
    ORDER BY s.created_at ASC, p.item_name ASC
  `
    )
    .all(...params);

  return rows.map((row) => {
    const unitPriceUsd = row.unit_price != null ? Number(row.unit_price) : Number(row.product_unit_price_usd || 0);
    const totalSaleUsd = row.total_sale != null ? Number(row.total_sale) : unitPriceUsd * Number(row.quantity || 0);
    const costPerUnitUsd =
      row.cost != null && row.quantity
        ? Number(row.cost) / Number(row.quantity)
        : Number(row.product_cost_usd || 0);
    const totalCostUsd =
      row.cost != null ? Number(row.cost) : costPerUnitUsd * Number(row.quantity || 0);
    const profitUsd =
      row.profit != null ? Number(row.profit) : totalSaleUsd - totalCostUsd;

    const unitPriceLL = unitPriceUsd * USD_TO_LL;
    const costPerUnitLL = costPerUnitUsd * USD_TO_LL;

    const profitRate = unitPriceUsd ? (unitPriceUsd - costPerUnitUsd) / unitPriceUsd : 0;

    return {
      barcode: row.product_barcode || row.barcode,
      item_name: row.item_name || "",
      brand: row.brand || "",
      quantity: Number(row.quantity || 0),
      unit_price_usd: unitPriceUsd,
      unit_price_ll: unitPriceLL,
      cost_usd: costPerUnitUsd,
      cost_ll: costPerUnitLL,
      profit_rate: profitRate,
      total_price_usd: totalSaleUsd,
      total_cost_usd: totalCostUsd,
      profit_usd: profitUsd,
      created_at: row.created_at,
    };
  });
}

module.exports = {
  recordOrderItemsToSales,
  getSalesReport,
};

