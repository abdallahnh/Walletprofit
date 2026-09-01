const { getDb } = require("./database");
const { findProductByBarcode } = require("./products");
const { getWalletConfig, normalizeType } = require("./wallet");
const orderItemsDb = require("./orderItems");
const { upsertAutomaticLineMeta, reconcileOrderMetaFromLines } = require("./orderLineMeta");

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

function getOrderMeta(db, orderCode) {
  if (!orderCode) return null;
  return db
    .prepare(
      `
    SELECT supplier_cost, supplier_paid
    FROM order_meta
    WHERE order_code = ?
  `
    )
    .get(orderCode);
}

function getEffectiveProductCostUsd(db, productId, asOf, fallbackCostUsd) {
  if (!productId || !asOf) return Number(fallbackCostUsd || 0);

  const row = db
    .prepare(
      `
    SELECT cost_usd
    FROM product_price_history
    WHERE product_id = ?
      AND datetime(effective_at) <= datetime(?)
    ORDER BY datetime(effective_at) DESC
    LIMIT 1
  `
    )
    .get(productId, asOf);

  if (!row || row.cost_usd == null) return Number(fallbackCostUsd || 0);
  return Number(row.cost_usd || 0);
}

function recordOrderItemsToSales(order) {
  const db = getDb();
  const orderItems = orderItemsDb.processOrderItems(order);
  if (!orderItems.length) {
    return {
      order_code: order?.code || null,
      total_items: 0,
      matched_items: 0,
      inserted_rows: 0,
      skipped_no_barcode: 0,
      skipped_unmatched_product: 0,
    };
  }

  const cfg = getWalletConfig();
  const usdToLbpRate = Number(cfg?.usdToLbpRate || 90000);
  const lbpToUsdRate = 1 / usdToLbpRate;
  const createdAt = order.created_at || new Date().toISOString();
  const orderManual = db.prepare(
    "SELECT * FROM order_meta WHERE order_code=? AND cost_source='manual_override'"
  ).get(order.code);
  const { serviceVatUsd: orderServiceVatUsd, incentiveUsd: orderIncentiveUsd } =
    getOrderAdjustmentsUsd(db, order.code, lbpToUsdRate);
  const catalogRows = orderItems.filter((item) => item.barcode && item.catalog_product_id);
  const totalOrderRevenueUsd = catalogRows.reduce(
    (sum, item) => sum + Number(item.total_selling_price_usd || 0),
    0
  );

  if (catalogRows.length === 0) {
    return {
      order_code: order?.code || null,
      total_items: orderItems.length,
      matched_items: 0,
      inserted_rows: 0,
      skipped_no_barcode: orderItems.filter((r) => r.catalog_sync_status === "missing_barcode").length,
      skipped_unmatched_product: orderItems.filter((r) => r.catalog_sync_status === "missing_product").length,
      preserved_existing: true,
    };
  }

  const insertStmt = db.prepare(
    `
    INSERT INTO sales (
      order_code, barcode, product_id, quantity, unit_price, cost, total_sale, profit, created_at,
      catalog_product_id, item_name_snapshot, image_url_snapshot,
      unit_supplier_cost_usd, total_supplier_cost_usd, supplier_id, merchant_code,
      catalog_sync_status, cost_source, cost_snapshot_at
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `
  );

  let insertedRows = 0;
  const insertAll = db.transaction(() => {
    db.prepare("DELETE FROM sales WHERE order_code = ?").run(order.code);
    for (const item of catalogRows) {
      const quantity = Number(item.quantity || 0);
      const priceUsd = Number(item.unit_selling_price_usd || 0);
      const grossTotal = Number(item.total_selling_price_usd || quantity * priceUsd);
      const manual = db.prepare(
        "SELECT * FROM order_line_meta WHERE order_code=? AND barcode=? AND cost_source='manual_override'"
      ).get(order.code, item.barcode);
      const effectiveManual = manual || (catalogRows.length === 1 ? orderManual : null);
      const hasKnownCost = effectiveManual || item.total_supplier_cost_usd != null;
      const cost = effectiveManual
        ? Number(effectiveManual.supplier_cost_lbp ?? effectiveManual.supplier_cost ?? 0) * lbpToUsdRate
        : hasKnownCost ? Number(item.total_supplier_cost_usd) : null;
      const supplierId = effectiveManual?.supplier_id || item.supplier_id || null;
      const costSource = effectiveManual ? "manual_override" : item.cost_source;
      const unitCost = effectiveManual && quantity > 0 ? cost / quantity : item.unit_supplier_cost_usd;
    const feeShare =
      totalOrderRevenueUsd > 0 ? (grossTotal / totalOrderRevenueUsd) * orderServiceVatUsd : 0;
    const incentiveShare =
      totalOrderRevenueUsd > 0 ? (grossTotal / totalOrderRevenueUsd) * orderIncentiveUsd : 0;
    const merchantRevenue = grossTotal - feeShare + incentiveShare;
      const profit = cost == null ? null : merchantRevenue - cost;
      const localProduct = findProductByBarcode(item.barcode);
      insertStmt.run(
        order.code, item.barcode, localProduct?.id || null, quantity, priceUsd, cost,
        merchantRevenue, profit, createdAt, item.catalog_product_id,
        item.item_name_snapshot, item.image_url_snapshot, unitCost,
        cost, supplierId, item.merchant_code, item.catalog_sync_status,
        costSource, item.cost_snapshot_at
      );
      insertedRows += 1;
      if (!effectiveManual && item.catalog_sync_status === "matched") {
        upsertAutomaticLineMeta({
          order_code: order.code, barcode: item.barcode, supplier_id: supplierId,
          supplier_cost_lbp: Number(item.total_supplier_cost_usd) * usdToLbpRate,
          merchant_code: item.merchant_code,
        });
      }
    }
    reconcileOrderMetaFromLines(order.code);
  });
  insertAll();

  return {
    order_code: order?.code || null,
    total_items: orderItems.length,
    matched_items: orderItems.filter((r) => r.catalog_sync_status === "matched").length,
    inserted_rows: insertedRows,
    skipped_no_barcode: orderItems.filter((r) => r.catalog_sync_status === "missing_barcode").length,
    skipped_unmatched_product: orderItems.filter((r) => r.catalog_sync_status === "missing_product").length,
    missing_vendor_price: orderItems.filter((r) => r.catalog_sync_status === "missing_vendor_price").length,
  };
}

function rebuildSalesFromStoredOrderItems(orderCode) {
  const rows = orderItemsDb.getOrderItems(orderCode);
  if (!rows.length) return { ok: true, inserted_rows: 0 };
  return recordOrderItemsToSales({
    code: orderCode,
    created_at: rows[0].order_created_at,
    order_detail: rows.map((row) => ({
      quantity: row.quantity,
      item_price: Number(row.unit_selling_price_usd || 0) * Number(getWalletConfig()?.usdToLbpRate || 90000),
      item: { barcode: row.barcode, item_name: row.item_name_snapshot },
    })),
  });
}

function buildSalesFilter(opts = {}) {
  const { from, to, supplierIds } = opts;
  const params = [];
  const where = [];
  let joinSql = "";

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

  const ids = Array.isArray(supplierIds)
    ? supplierIds.map(Number).filter((id) => id > 0)
    : [];

  if (ids.length > 0) {
    joinSql = "LEFT JOIN order_meta om ON om.order_code = s.order_code";
    where.push(`COALESCE(s.supplier_id, om.supplier_id) IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { joinSql, whereSql, params };
}

function getSalesReport(opts = {}) {
  const db = getDb();
  const { joinSql, whereSql, params } = buildSalesFilter(opts);

  const rows = db
    .prepare(
      `
    SELECT
      COALESCE(s.barcode, p.barcode) AS barcode,
      COALESCE(s.item_name_snapshot, p.item_name, s.barcode) AS item_name,
      p.brand,
      SUM(s.quantity) AS sold_qty,
      SUM(s.total_sale) AS revenue,
      SUM(CASE WHEN s.cost IS NULL THEN 1 ELSE 0 END) AS missing_cost_rows,
      CASE WHEN SUM(CASE WHEN s.cost IS NULL THEN 1 ELSE 0 END) = 0
        THEN SUM(s.cost) ELSE NULL END AS supplier_cost,
      CASE WHEN SUM(CASE WHEN s.profit IS NULL THEN 1 ELSE 0 END) = 0
        THEN SUM(s.profit) ELSE NULL END AS profit
    FROM sales s
    LEFT JOIN products p ON s.product_id = p.id
    ${joinSql}
    ${whereSql}
    GROUP BY COALESCE(s.barcode, p.barcode), COALESCE(s.item_name_snapshot, p.item_name, s.barcode), p.brand
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
    supplier_cost: row.supplier_cost == null ? null : Number(row.supplier_cost),
    profit: row.profit == null ? null : Number(row.profit),
    missing_cost_rows: Number(row.missing_cost_rows || 0),
    cost_status: Number(row.missing_cost_rows || 0) > 0 ? "Missing Vendor Price" : "complete",
  }));
}

function getRevenueByPeriod(opts = {}) {
  const db = getDb();
  const { period = 'day' } = opts;
  const { joinSql, whereSql, params } = buildSalesFilter(opts);

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

  const rows = db
    .prepare(
      `
    SELECT
      ${dateFormat} AS period,
      SUM(s.total_sale) AS revenue,
      SUM(CASE WHEN s.cost IS NULL THEN 1 ELSE 0 END) AS missing_cost_rows,
      CASE WHEN SUM(CASE WHEN s.cost IS NULL THEN 1 ELSE 0 END)=0 THEN SUM(s.cost) ELSE NULL END AS cost,
      CASE WHEN SUM(CASE WHEN s.profit IS NULL THEN 1 ELSE 0 END)=0 THEN SUM(s.profit) ELSE NULL END AS profit,
      SUM(s.quantity) AS quantity_sold,
      COUNT(DISTINCT s.order_code) AS order_count
    FROM sales s
    ${joinSql}
    ${whereSql}
    GROUP BY ${dateFormat}
    ORDER BY ${dateFormat}
  `
    )
    .all(...params);

  return rows.map((row) => ({
    period: row.period,
    revenue: Number(row.revenue || 0),
    cost: row.cost == null ? null : Number(row.cost),
    profit: row.profit == null ? null : Number(row.profit),
    missing_cost_rows: Number(row.missing_cost_rows || 0),
    quantity_sold: Number(row.quantity_sold || 0),
    order_count: Number(row.order_count || 0),
  }));
}

function getTopProductsByRevenue(opts = {}) {
  const db = getDb();
  const { limit = 10 } = opts;
  const { joinSql, whereSql, params } = buildSalesFilter(opts);

  const rows = db
    .prepare(
      `
    SELECT
      COALESCE(s.barcode, p.barcode) AS barcode,
      COALESCE(s.item_name_snapshot, p.item_name, s.barcode) AS item_name,
      p.brand,
      SUM(s.quantity) AS sold_qty,
      SUM(s.total_sale) AS revenue,
      SUM(CASE WHEN s.cost IS NULL THEN 1 ELSE 0 END) AS missing_cost_rows,
      CASE WHEN SUM(CASE WHEN s.cost IS NULL THEN 1 ELSE 0 END)=0 THEN SUM(s.cost) ELSE NULL END AS supplier_cost,
      CASE WHEN SUM(CASE WHEN s.profit IS NULL THEN 1 ELSE 0 END)=0 THEN SUM(s.profit) ELSE NULL END AS profit
    FROM sales s
    LEFT JOIN products p ON s.product_id = p.id
    ${joinSql}
    ${whereSql}
    GROUP BY COALESCE(s.barcode, p.barcode), COALESCE(s.item_name_snapshot, p.item_name, s.barcode), p.brand
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
    supplier_cost: row.supplier_cost == null ? null : Number(row.supplier_cost),
    profit: row.profit == null ? null : Number(row.profit),
    missing_cost_rows: Number(row.missing_cost_rows || 0),
  }));
}

function getTopProductsByProfit(opts = {}) {
  const db = getDb();
  const { limit = 10 } = opts;
  const { joinSql, whereSql, params } = buildSalesFilter(opts);

  const rows = db
    .prepare(
      `
    SELECT
      COALESCE(s.barcode, p.barcode) AS barcode,
      COALESCE(s.item_name_snapshot, p.item_name, s.barcode) AS item_name,
      p.brand,
      SUM(s.quantity) AS sold_qty,
      SUM(s.total_sale) AS revenue,
      SUM(CASE WHEN s.cost IS NULL THEN 1 ELSE 0 END) AS missing_cost_rows,
      CASE WHEN SUM(CASE WHEN s.cost IS NULL THEN 1 ELSE 0 END)=0 THEN SUM(s.cost) ELSE NULL END AS supplier_cost,
      CASE WHEN SUM(CASE WHEN s.profit IS NULL THEN 1 ELSE 0 END)=0 THEN SUM(s.profit) ELSE NULL END AS profit
    FROM sales s
    LEFT JOIN products p ON s.product_id = p.id
    ${joinSql}
    ${whereSql}
    GROUP BY COALESCE(s.barcode, p.barcode), COALESCE(s.item_name_snapshot, p.item_name, s.barcode), p.brand
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
    supplier_cost: row.supplier_cost == null ? null : Number(row.supplier_cost),
    profit: row.profit == null ? null : Number(row.profit),
    missing_cost_rows: Number(row.missing_cost_rows || 0),
  }));
}

function getProfitMarginAnalysis(opts = {}) {
  const db = getDb();
  const { limit = 20 } = opts;
  const { joinSql, whereSql, params } = buildSalesFilter(opts);

  const rows = db
    .prepare(
      `
    SELECT
      COALESCE(s.barcode, p.barcode) AS barcode,
      COALESCE(s.item_name_snapshot, p.item_name, s.barcode) AS item_name,
      p.brand,
      AVG(s.unit_price) AS unit_price_usd,
      AVG(COALESCE(s.unit_supplier_cost_usd, p.cost_usd)) AS cost_usd,
      SUM(s.quantity) AS sold_qty,
      SUM(s.total_sale) AS revenue,
      SUM(CASE WHEN s.cost IS NULL THEN 1 ELSE 0 END) AS missing_cost_rows,
      CASE WHEN SUM(CASE WHEN s.cost IS NULL THEN 1 ELSE 0 END)=0 THEN SUM(s.cost) ELSE NULL END AS supplier_cost,
      CASE WHEN SUM(CASE WHEN s.profit IS NULL THEN 1 ELSE 0 END)=0 THEN SUM(s.profit) ELSE NULL END AS profit,
      CASE
        WHEN SUM(CASE WHEN s.profit IS NULL THEN 1 ELSE 0 END)=0 AND SUM(s.total_sale) > 0
        THEN (SUM(s.profit) / SUM(s.total_sale)) * 100 
        ELSE 0 
      END AS profit_margin_percent
    FROM sales s
    LEFT JOIN products p ON s.product_id = p.id
    ${joinSql}
    ${whereSql}
    GROUP BY COALESCE(s.barcode, p.barcode), COALESCE(s.item_name_snapshot, p.item_name, s.barcode), p.brand
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
    supplier_cost: row.supplier_cost == null ? null : Number(row.supplier_cost),
    profit: row.profit == null ? null : Number(row.profit),
    profit_margin_percent: row.profit_margin_percent == null ? null : Number(row.profit_margin_percent),
    missing_cost_rows: Number(row.missing_cost_rows || 0),
  }));
}

function applyOrderSupplierCost(orderCode, supplierCostLbp, usdToLbpRate = 90000) {
  const db = getDb();
  const code = String(orderCode || "").trim();
  if (!code) return { ok: false, error: "Missing order code" };

  const rows = db
    .prepare(
      `
    SELECT id, product_id, quantity, total_sale, created_at
    FROM sales
    WHERE order_code = ?
  `
    )
    .all(code);

  if (!rows.length) {
    return { ok: true, affectedRows: 0 };
  }

  const totalSale = rows.reduce((sum, r) => sum + Number(r.total_sale || 0), 0);
  const useOverride = Number(supplierCostLbp || 0) > 0;
  const overrideCostUsd = useOverride ? Number(supplierCostLbp || 0) / Number(usdToLbpRate || 90000) : 0;

  const updateStmt = db.prepare(`
    UPDATE sales
    SET cost = ?, profit = ?
    WHERE id = ?
  `);

  const productCostStmt = db.prepare(`
    SELECT cost_usd
    FROM products
    WHERE id = ?
  `);

  const run = db.transaction(() => {
    for (const row of rows) {
      const saleValue = Number(row.total_sale || 0);
      let cost = 0;
      if (useOverride) {
        cost = totalSale > 0 ? (saleValue / totalSale) * overrideCostUsd : 0;
      } else {
        const p = productCostStmt.get(row.product_id);
        const historicalCostUsd = getEffectiveProductCostUsd(
          db,
          row.product_id,
          row.created_at,
          p?.cost_usd || 0
        );
        cost = historicalCostUsd * Number(row.quantity || 0);
      }

      const profit = saleValue - cost;
      updateStmt.run(cost, profit, row.id);
    }
  });

  run();
  return { ok: true, affectedRows: rows.length };
}

function applyLineSupplierCost(
  orderCode, barcode, supplierCostLbp, usdToLbpRate = 90000, supplierId = null
) {
  const db = getDb();
  const code = String(orderCode || "").trim();
  const bc = String(barcode || "").trim();
  if (!code || !bc) return { ok: false, error: "Missing order code or barcode" };

  const row = db
    .prepare(
      `
    SELECT id, total_sale, quantity
    FROM sales
    WHERE order_code = ? AND barcode = ?
  `
    )
    .get(code, bc);

  if (!row) return { ok: true, affectedRows: 0 };

  const costUsd = Number(supplierCostLbp || 0) / Number(usdToLbpRate || 90000);
  const profit = Number(row.total_sale || 0) - costUsd;

  db.prepare(
    `
    UPDATE sales
    SET cost = ?, profit = ?, unit_supplier_cost_usd = ?,
        total_supplier_cost_usd = ?, supplier_id = ?, cost_source = 'manual_override',
        cost_snapshot_at = datetime('now')
    WHERE id = ?
  `
  ).run(
    costUsd, profit, Number(row.quantity || 0) > 0 ? costUsd / Number(row.quantity) : costUsd,
    costUsd, supplierId ? Number(supplierId) : null, row.id
  );

  return { ok: true, affectedRows: 1 };
}

module.exports = {
  recordOrderItemsToSales,
  rebuildSalesFromStoredOrderItems,
  applyOrderSupplierCost,
  applyLineSupplierCost,
  getSalesReport,
  getRevenueByPeriod,
  getTopProductsByRevenue,
  getTopProductsByProfit,
  getProfitMarginAnalysis,
};

