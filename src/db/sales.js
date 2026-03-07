const { getDb } = require("./database");
const { findProductByBarcode } = require("./products");

function recordOrderItemsToSales(order) {
  const db = getDb();
  const items = order.order_detail || [];
  if (!items.length) return;

  const insertStmt = db.prepare(
    `
    INSERT OR IGNORE INTO sales (
      order_code,
      barcode,
      product_id,
      quantity,
      unit_price,
      cost,
      total_sale,
      profit,
      created_at
    )
    VALUES (?,?,?,?,?,?,?,?,?)
  `
  );

  const updateStockStmt = db.prepare(
    `
    UPDATE products
    SET stock_quantity = stock_quantity - ?
    WHERE barcode = ?
  `
  );

  const createdAt = order.created_at || new Date().toISOString();

  const runTx = db.transaction(() => {
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

      const info = insertStmt.run(
        order.code,
        barcode,
        product.id,
        qty,
        price,
        cost,
        total,
        profit,
        createdAt
      );

      // Only reduce stock if we actually inserted a new sales row
      if (info.changes === 1) {
        updateStockStmt.run(qty, barcode);
      }
    }
  });

  runTx();
}

function getSalesReport(opts = {}) {
  const db = getDb();
  const { from, to } = opts;

  const params = [];
  const where = [];

  if (from && to) {
    where.push("datetime(s.created_at) BETWEEN datetime(?) AND datetime(?)");
    params.push(from, to);
  } else if (from) {
    where.push("datetime(s.created_at) >= datetime(?)");
    params.push(from);
  } else if (to) {
    where.push("datetime(s.created_at) <= datetime(?)");
    params.push(to);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `
    SELECT
      p.barcode,
      p.item_name,
      p.brand,
      SUM(s.quantity) AS sold_qty,
      SUM(s.total_sale) AS revenue,
      SUM(s.cost) AS supplier_cost,
      SUM(s.profit) AS profit
    FROM sales s
    JOIN products p ON s.product_id = p.id
    ${whereSql}
    GROUP BY p.barcode, p.item_name, p.brand
    ORDER BY sold_qty DESC
  `
    )
    .all(...params);

  return rows.map((row) => ({
    barcode: row.barcode,
    item_name: row.item_name,
    brand: row.brand,
    sold_qty: Number(row.sold_qty || 0),
    revenue: Number(row.revenue || 0),
    supplier_cost: Number(row.supplier_cost || 0),
    profit: Number(row.profit || 0),
  }));
}

module.exports = {
  recordOrderItemsToSales,
  getSalesReport,
};

