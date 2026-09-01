const { getDb } = require("./database");
const { getWalletConfig } = require("./wallet");

function getLineMetaRows(db, orderCode) {
  return db
    .prepare(
      `
    SELECT olm.order_code, olm.barcode, olm.supplier_id, olm.supplier_cost_lbp, olm.supplier_paid,
           olm.cost_source, olm.merchant_code,
           COALESCE(oi.item_name_snapshot, p.item_name) AS item_name,
           oi.quantity, oi.image_url_snapshot, oi.unit_supplier_cost_usd,
           oi.catalog_sync_status, oi.catalog_error,
           s.name AS supplier_name, s.color AS supplier_color, s.phone AS supplier_phone
    FROM order_line_meta olm
    LEFT JOIN order_items oi ON oi.order_code=olm.order_code AND oi.barcode=olm.barcode
    LEFT JOIN products p ON p.barcode = olm.barcode
    LEFT JOIN suppliers s ON s.id = olm.supplier_id
    WHERE olm.order_code = ?
    ORDER BY p.item_name, olm.barcode
  `
    )
    .all(orderCode);
}

function getSalesItemCount(db, orderCode) {
  const row = db
    .prepare(
      `
    SELECT COUNT(*) AS cnt
    FROM order_items
    WHERE order_code = ?
  `
    )
    .get(orderCode);
  return Number(row?.cnt || 0);
}

function ensureLineMetaFromSales(orderCode) {
  const db = getDb();
  const code = String(orderCode || "").trim();
  if (!code) return { ok: false, error: "Missing order_code" };

  const cfg = getWalletConfig() || {};
  const rate = Number(cfg.usdToLbpRate || 90000);

  const salesRows = db
    .prepare(
      `
    SELECT s.barcode, s.quantity, s.cost, s.total_sale, p.item_name
    FROM sales s
    LEFT JOIN products p ON p.id = s.product_id
    WHERE s.order_code = ? AND s.barcode IS NOT NULL AND s.barcode != ''
      AND (s.catalog_product_id IS NULL OR s.cost_source IS NOT NULL)
    ORDER BY p.item_name, s.barcode
  `
    )
    .all(code);

  if (salesRows.length <= 1) {
    return { ok: true, mode: "single", lines: getLineMetaRows(db, code) };
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO order_line_meta (order_code, barcode, supplier_id, supplier_cost_lbp, supplier_paid, cost_source, updated_at)
    VALUES (?, ?, NULL, ?, 0, 'legacy_snapshot', datetime('now'))
  `);

  for (const s of salesRows) {
    const defaultCostLbp = Math.round(Number(s.cost || 0) * rate);
    insert.run(code, s.barcode, defaultCostLbp);
  }

  reconcileOrderMetaFromLines(code);
  return { ok: true, mode: "multi", lines: getLineMetaRows(db, code) };
}

function getLineMetaForOrder(orderCode) {
  const db = getDb();
  const code = String(orderCode || "").trim();
  if (!code) return [];

  const itemCount = getSalesItemCount(db, code);
  if (itemCount > 1) {
    ensureLineMetaFromSales(code);
  }

  return getLineMetaRows(db, code);
}

function getOrderLineTotals(orderCode) {
  const db = getDb();
  const lines = getLineMetaRows(db, orderCode);
  if (!lines.length) {
    return { has_lines: false, line_count: 0, item_count: getSalesItemCount(db, orderCode) };
  }

  const supplierIds = [...new Set(lines.map((l) => l.supplier_id).filter(Boolean))];
  const names = [...new Set(lines.map((l) => l.supplier_name).filter(Boolean))];
  const totalCost = lines.reduce((sum, l) => sum + Number(l.supplier_cost_lbp || 0), 0);
  const allPaid = lines.every((l) => !Number(l.supplier_cost_lbp || 0) || l.supplier_paid);
  const hasManualOverride = lines.some((l) => l.cost_source === "manual_override");

  return {
    has_lines: true,
    line_count: lines.length,
    item_count: getSalesItemCount(db, orderCode),
    supplier_cost: totalCost,
    supplier_paid: allPaid ? 1 : 0,
    supplier_id: supplierIds.length === 1 ? supplierIds[0] : null,
    supplier_line_ids: supplierIds,
    supplier_name:
      names.length === 0
        ? "(Unassigned)"
        : names.length === 1
          ? names[0]
          : names.join(", "),
    is_multi_supplier: supplierIds.length > 1,
    cost_source: hasManualOverride ? "manual_override" : "catalog_snapshot",
    lines,
  };
}

function reconcileOrderMetaFromLines(orderCode) {
  const db = getDb();
  const code = String(orderCode || "").trim();
  if (!code) return;

  const totals = getOrderLineTotals(code);
  if (!totals.has_lines) return;

  db.prepare(
    `
    INSERT INTO order_meta (order_code, supplier_cost, supplier_paid, supplier_id, cost_source, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(order_code) DO UPDATE SET
      supplier_cost = CASE WHEN order_meta.cost_source='manual_override' THEN order_meta.supplier_cost ELSE excluded.supplier_cost END,
      supplier_paid = CASE WHEN order_meta.cost_source='manual_override' THEN order_meta.supplier_paid ELSE excluded.supplier_paid END,
      supplier_id = CASE WHEN order_meta.cost_source='manual_override' THEN order_meta.supplier_id ELSE excluded.supplier_id END,
      cost_source = CASE WHEN order_meta.cost_source='manual_override' THEN order_meta.cost_source ELSE excluded.cost_source END,
      updated_at = datetime('now')
  `
  ).run(code, totals.supplier_cost, totals.supplier_paid, totals.supplier_id, totals.cost_source);
}

function upsertLineMeta({ order_code, barcode, supplier_id, supplier_cost_lbp, supplier_paid }) {
  const code = String(order_code || "").trim();
  const bc = String(barcode || "").trim();
  if (!code || !bc) return { ok: false, error: "Missing order_code or barcode" };

  const cost = Math.trunc(supplier_cost_lbp || 0);
  const paid = supplier_paid ? 1 : 0;
  const sid = supplier_id ? Number(supplier_id) || null : null;

  if ((cost > 0 || paid) && !sid) {
    return { ok: false, error: "Supplier is required when setting line cost or paid status" };
  }

  const db = getDb();
  db.prepare(
    `
    INSERT INTO order_line_meta (order_code, barcode, supplier_id, supplier_cost_lbp, supplier_paid, cost_source, updated_at)
    VALUES (?, ?, ?, ?, ?, 'manual_override', datetime('now'))
    ON CONFLICT(order_code, barcode) DO UPDATE SET
      supplier_id = excluded.supplier_id,
      supplier_cost_lbp = excluded.supplier_cost_lbp,
      supplier_paid = excluded.supplier_paid,
      cost_source = 'manual_override',
      updated_at = datetime('now')
  `
  ).run(code, bc, sid, cost, paid);

  reconcileOrderMetaFromLines(code);
  return { ok: true };
}

function upsertAutomaticLineMeta({ order_code, barcode, supplier_id, supplier_cost_lbp, merchant_code }) {
  const db = getDb();
  const existing = db.prepare(
    "SELECT cost_source FROM order_line_meta WHERE order_code=? AND barcode=?"
  ).get(order_code, barcode);
  if (existing?.cost_source === "manual_override") return { ok: true, preserved_manual: true };
  db.prepare(`
    INSERT INTO order_line_meta (
      order_code, barcode, supplier_id, supplier_cost_lbp, supplier_paid,
      cost_source, merchant_code, updated_at
    ) VALUES (?, ?, ?, ?, 0, 'catalog_snapshot', ?, datetime('now'))
    ON CONFLICT(order_code,barcode) DO UPDATE SET
      supplier_id=excluded.supplier_id,
      supplier_cost_lbp=excluded.supplier_cost_lbp,
      cost_source='catalog_snapshot',
      merchant_code=excluded.merchant_code,
      updated_at=datetime('now')
  `).run(order_code, barcode, supplier_id || null, Math.round(supplier_cost_lbp || 0), merchant_code || null);
  reconcileOrderMetaFromLines(order_code);
  return { ok: true };
}

function clearLineMetaForOrder(orderCode) {
  const db = getDb();
  db.prepare("DELETE FROM order_line_meta WHERE order_code = ?").run(String(orderCode || "").trim());
}

function getItemCountsByOrder() {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT order_code, COUNT(*) AS item_count
    FROM order_items
    WHERE order_code IS NOT NULL
    GROUP BY order_code
    HAVING item_count > 1
  `
    )
    .all();
  return new Map(rows.map((r) => [r.order_code, Number(r.item_count)]));
}

function getOrderItemsMap(db) {
  const rows = db
    .prepare(
      `
    SELECT order_code, barcode, quantity, item_name_snapshot AS item_name,
           image_url_snapshot AS image_url, unit_supplier_cost_usd AS vendor_price_usd,
           supplier_id, merchant_code, catalog_sync_status, catalog_error
    FROM order_items
    WHERE order_code IS NOT NULL
    ORDER BY order_code, id
  `
    )
    .all();

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.order_code)) map.set(r.order_code, []);
    map.get(r.order_code).push({
      barcode: r.barcode,
      item_name: r.item_name || r.barcode,
      quantity: Number(r.quantity || 0),
      image_url: r.image_url || null,
      vendor_price_usd: r.vendor_price_usd,
      supplier_id: r.supplier_id,
      merchant_code: r.merchant_code,
      catalog_sync_status: r.catalog_sync_status,
      catalog_error: r.catalog_error,
    });
  }
  return map;
}

module.exports = {
  getLineMetaForOrder,
  getOrderLineTotals,
  ensureLineMetaFromSales,
  upsertLineMeta,
  upsertAutomaticLineMeta,
  reconcileOrderMetaFromLines,
  clearLineMetaForOrder,
  getItemCountsByOrder,
  getSalesItemCount,
  getOrderItemsMap,
};
