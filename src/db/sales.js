const { getDb } = require("./database");
const { findProductByBarcode } = require("./products");
const { getWalletConfig, normalizeType } = require("./wallet");

function getOrderAdjustmentsUsd(db, orderCode, lbpToUsdRate) {
  if (!orderCode) return { serviceVatUsd: 0, incentiveUsd: 0 };

  const txRows = db
    .prepare(
      `
    SELECT amount, type
    FROM transactions
    WHERE order_code = ?
  `
    )
    .all(orderCode);

  let service = 0;
  let vat = 0;
  let incentive = 0;
  for (const r of txRows) {
    const kind = normalizeType(r.type);
    const amt = Number(r.amount || 0);
    if (kind === "service_fee") service += amt;
    if (kind === "vat") vat += amt;
    if (kind === "incentive") incentive += Math.abs(amt);
  }

  return {
    serviceVatUsd: (service + vat) * lbpToUsdRate,
    incentiveUsd: incentive * lbpToUsdRate,
  };
}

function recordOrderItemsToSales(order) {
  const db = getDb();
  const items = order.order_detail || [];
  if (!items.length) {
    return {
      order_code: order?.code || null,
      total_items: 0,
      matched_items: 0,
      inserted_rows: 0,
      skipped_no_barcode: 0,
      skipped_unmatched_product: 0,
    };
  }

  // Keep sync idempotent: re-syncing the same order should overwrite prior sales rows.
  db.prepare("DELETE FROM sales WHERE order_code = ?").run(order.code);

  // Get currency conversion rate
  const cfg = getWalletConfig();
  const usdToLbpRate = cfg?.usdToLbpRate || 90000;
  const lbpToUsdRate = 1 / usdToLbpRate;

  // Aggregate items by barcode to handle duplicates
  const aggregatedItems = {};
  let skippedNoBarcode = 0;
  let skippedUnmatchedProduct = 0;
  let matchedItems = 0;
  for (const d of items) {
    const item = d.item || {};
    const barcode = item.barcode;
    if (!barcode) {
      skippedNoBarcode += 1;
      continue;
    }

    const product = findProductByBarcode(barcode);
    if (!product) {
      skippedUnmatchedProduct += 1;
      continue;
    }
    matchedItems += 1;

    const qty = Number(d.quantity || 0);
    const priceLbp = Number(d.item_price || 0);
    const priceUsd = priceLbp * lbpToUsdRate; // Convert LBP to USD

    if (aggregatedItems[barcode]) {
      aggregatedItems[barcode].quantity += qty;
      // Use the latest price if different
      if (priceUsd > 0) aggregatedItems[barcode].priceUsd = priceUsd;
    } else {
      aggregatedItems[barcode] = {
        product,
        quantity: qty,
        priceUsd: priceUsd
      };
    }
  }

  const createdAt = order.created_at || new Date().toISOString();
  const { serviceVatUsd: orderServiceVatUsd, incentiveUsd: orderIncentiveUsd } =
    getOrderAdjustmentsUsd(db, order.code, lbpToUsdRate);
  const totalOrderRevenueUsd = Object.values(aggregatedItems).reduce(
    (sum, it) => sum + Number(it.quantity || 0) * Number(it.priceUsd || 0),
    0
  );

  // Simple insert - let duplicates exist for now
  const insertStmt = db.prepare(
    `
    INSERT INTO sales (
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

  let insertedRows = 0;
  for (const [barcode, data] of Object.entries(aggregatedItems)) {
    const { product, quantity, priceUsd } = data;

    const grossTotal = quantity * priceUsd;
    const cost = (product.cost_usd || 0) * quantity;
    const feeShare =
      totalOrderRevenueUsd > 0 ? (grossTotal / totalOrderRevenueUsd) * orderServiceVatUsd : 0;
    const incentiveShare =
      totalOrderRevenueUsd > 0 ? (grossTotal / totalOrderRevenueUsd) * orderIncentiveUsd : 0;

    // Merchant revenue is what remains after platform fees and VAT, plus incentives.
    const merchantRevenue = grossTotal - feeShare + incentiveShare;
    const profit = merchantRevenue - cost;

    try {
      insertStmt.run(
        order.code,
        barcode,
        product.id,
        quantity,
        priceUsd,
        cost,
        merchantRevenue,
        profit,
        createdAt
      );
      insertedRows += 1;
    } catch (e) {
      // Ignore duplicate errors for now
      console.log('Ignoring sales insert error:', e.message);
    }
  }

  return {
    order_code: order?.code || null,
    total_items: items.length,
    matched_items: matchedItems,
    inserted_rows: insertedRows,
    skipped_no_barcode: skippedNoBarcode,
    skipped_unmatched_product: skippedUnmatchedProduct,
  };
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

function getRevenueByPeriod(opts = {}) {
  const db = getDb();
  const { from, to, period = 'day' } = opts;

  let dateFormat;
  switch (period) {
    case 'month':
      dateFormat = "strftime('%Y-%m', s.created_at)";
      break;
    case 'week':
      dateFormat = "strftime('%Y-%W', s.created_at)";
      break;
    case 'day':
    default:
      dateFormat = "strftime('%Y-%m-%d', s.created_at)";
      break;
  }

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
      ${dateFormat} AS period,
      SUM(s.total_sale) AS revenue,
      SUM(s.cost) AS cost,
      SUM(s.profit) AS profit,
      SUM(s.quantity) AS quantity_sold,
      COUNT(DISTINCT s.order_code) AS order_count
    FROM sales s
    ${whereSql}
    GROUP BY ${dateFormat}
    ORDER BY ${dateFormat}
  `
    )
    .all(...params);

  return rows.map((row) => ({
    period: row.period,
    revenue: Number(row.revenue || 0),
    cost: Number(row.cost || 0),
    profit: Number(row.profit || 0),
    quantity_sold: Number(row.quantity_sold || 0),
    order_count: Number(row.order_count || 0),
  }));
}

function getTopProductsByRevenue(opts = {}) {
  const db = getDb();
  const { from, to, limit = 10 } = opts;

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
    ORDER BY revenue DESC
    LIMIT ?
  `
    )
    .all(...params, limit);

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

function getTopProductsByProfit(opts = {}) {
  const db = getDb();
  const { from, to, limit = 10 } = opts;

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
    ORDER BY profit DESC
    LIMIT ?
  `
    )
    .all(...params, limit);

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

function getProfitMarginAnalysis(opts = {}) {
  const db = getDb();
  const { from, to, limit = 20 } = opts;

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
      p.unit_price_usd,
      p.cost_usd,
      SUM(s.quantity) AS sold_qty,
      SUM(s.total_sale) AS revenue,
      SUM(s.cost) AS supplier_cost,
      SUM(s.profit) AS profit,
      CASE 
        WHEN SUM(s.total_sale) > 0 
        THEN (SUM(s.profit) / SUM(s.total_sale)) * 100 
        ELSE 0 
      END AS profit_margin_percent
    FROM sales s
    JOIN products p ON s.product_id = p.id
    ${whereSql}
    GROUP BY p.barcode, p.item_name, p.brand, p.unit_price_usd, p.cost_usd
    HAVING sold_qty > 0
    ORDER BY profit_margin_percent DESC
    LIMIT ?
  `
    )
    .all(...params, limit);

  return rows.map((row) => ({
    barcode: row.barcode,
    item_name: row.item_name,
    brand: row.brand,
    unit_price: Number(row.unit_price_usd || 0),
    cost_price: Number(row.cost_usd || 0),
    sold_qty: Number(row.sold_qty || 0),
    revenue: Number(row.revenue || 0),
    supplier_cost: Number(row.supplier_cost || 0),
    profit: Number(row.profit || 0),
    profit_margin_percent: Number(row.profit_margin_percent || 0),
  }));
}

module.exports = {
  recordOrderItemsToSales,
  getSalesReport,
  getRevenueByPeriod,
  getTopProductsByRevenue,
  getTopProductsByProfit,
  getProfitMarginAnalysis,
};

