const { getDb } = require("./database");
const catalogCache = require("./productCatalogCache");
const { getSupplierByCatalogKey } = require("./suppliers");
const { getWalletConfig } = require("./wallet");
const {
  normalizeOrderDetailItems,
  extractOrderItemImageUrl,
} = require("../services/orderDetailItems");

const UPSERT_SQL = [
  "INSERT INTO order_items (order_code,line_key,barcode,item_name_snapshot,quantity,",
  "unit_selling_price_usd,total_selling_price_usd,catalog_product_id,image_url_snapshot,",
  "supplier_id,supplier_key,merchant_code,unit_supplier_cost_usd,total_supplier_cost_usd,",
  "cost_source,catalog_sync_status,catalog_error,order_created_at,cost_snapshot_at,updated_at)",
  "VALUES (@order_code,@line_key,@barcode,@item_name_snapshot,@quantity,",
  "@unit_selling_price_usd,@total_selling_price_usd,@catalog_product_id,@image_url_snapshot,",
  "@supplier_id,@supplier_key,@merchant_code,@unit_supplier_cost_usd,@total_supplier_cost_usd,",
  "@cost_source,@catalog_sync_status,@catalog_error,@order_created_at,@cost_snapshot_at,datetime('now'))",
  "ON CONFLICT(order_code,line_key) DO UPDATE SET barcode=excluded.barcode,",
  "item_name_snapshot=excluded.item_name_snapshot,quantity=excluded.quantity,",
  "unit_selling_price_usd=excluded.unit_selling_price_usd,total_selling_price_usd=excluded.total_selling_price_usd,",
  "catalog_product_id=excluded.catalog_product_id,image_url_snapshot=excluded.image_url_snapshot,",
  "supplier_id=excluded.supplier_id,supplier_key=excluded.supplier_key,merchant_code=excluded.merchant_code,",
  "unit_supplier_cost_usd=excluded.unit_supplier_cost_usd,total_supplier_cost_usd=excluded.total_supplier_cost_usd,",
  "cost_source=excluded.cost_source,catalog_sync_status=excluded.catalog_sync_status,",
  "catalog_error=excluded.catalog_error,order_created_at=excluded.order_created_at,",
  "cost_snapshot_at=excluded.cost_snapshot_at,updated_at=datetime('now')",
].join(" ");

function detailName(detail) {
  const item = detail?.item || {};
  return String(item.item_name ?? item.name ?? item.ref ?? detail.item_name ??
    detail.name ?? item.barcode ?? "Unknown item");
}

function aggregateOrderDetails(order) {
  const rate = Number(getWalletConfig()?.usdToLbpRate || 90000);
  const grouped = new Map();
  normalizeOrderDetailItems(order?.order_detail).forEach((detail, index) => {
    const barcode = String(detail?.item?.barcode || "").trim() || null;
    const lineKey = barcode ? "barcode:" + barcode : "line:" + index;
    const quantity = Number(detail.quantity || 0);
    const unitPriceUsd = Number(detail.item_price || 0) / rate;
    if (barcode && grouped.has(lineKey)) {
      const row = grouped.get(lineKey);
      row.quantity += quantity;
      if (unitPriceUsd > 0) row.unit_selling_price_usd = unitPriceUsd;
      if (!row.image_url_snapshot) row.image_url_snapshot = extractOrderItemImageUrl(detail);
      row.total_selling_price_usd = row.quantity * row.unit_selling_price_usd;
      return;
    }
    grouped.set(lineKey, {
      order_code: String(order.code || ""),
      line_key: lineKey,
      barcode,
      item_name_snapshot: detailName(detail),
      quantity,
      unit_selling_price_usd: unitPriceUsd,
      total_selling_price_usd: quantity * unitPriceUsd,
      image_url_snapshot: extractOrderItemImageUrl(detail),
      order_created_at: order.created_at || new Date().toISOString(),
    });
  });
  return Array.from(grouped.values());
}

function enrichLine(base, existing = null, { allowCostSnapshot = true } = {}) {
  const syncedImage = base.image_url_snapshot || existing?.image_url_snapshot || null;
  if (!base.barcode) return {
    ...base,
    image_url_snapshot: syncedImage,
    catalog_sync_status: "missing_barcode",
    catalog_error: "Order item has no barcode",
    cost_source: existing?.cost_source || null,
  };
  const product = catalogCache.getProductByBarcode(base.barcode);
  if (!product) {
    const refreshed = catalogCache.hasSuccessfulRefresh();
    return {
      ...base,
      image_url_snapshot: syncedImage,
      catalog_sync_status: refreshed ? "missing_product" : "pending",
      catalog_error: refreshed
        ? "Barcode does not exist in the product catalog"
        : "Product catalog cache has not been refreshed",
      cost_source: existing?.cost_source || null,
    };
  }
  const preserve = !!existing?.cost_source && existing?.unit_supplier_cost_usd != null;
  const hasVendorPrice = product.vendor_price_usd != null;
  const currentVendorPrice = hasVendorPrice
    ? Number(product.vendor_price_usd)
    : product.legacy_cost_usd == null ? null : Number(product.legacy_cost_usd);
  const catalogCostSource = hasVendorPrice ? "catalog_snapshot" : "catalog_cost_fallback";
  const unitCost = preserve ? Number(existing.unit_supplier_cost_usd) :
    allowCostSnapshot ? currentVendorPrice : null;
  const supplier = preserve && existing?.supplier_id
    ? { id: existing.supplier_id }
    : getSupplierByCatalogKey(product.supplier_key);
  const status = unitCost != null
    ? "matched"
    : currentVendorPrice == null
      ? "missing_vendor_price"
      : "historical_cost_review";
  return {
    ...base,
    item_name_snapshot: preserve ? existing.item_name_snapshot :
      product.item_name || base.item_name_snapshot,
    catalog_product_id: product.id,
    image_url_snapshot: syncedImage || product.image_url || null,
    supplier_id: supplier?.id || existing?.supplier_id || null,
    supplier_key: preserve ? existing.supplier_key : product.supplier_key || null,
    merchant_code: preserve ? existing.merchant_code : product.merchant_code || null,
    unit_supplier_cost_usd: unitCost,
    total_supplier_cost_usd: unitCost == null ? null : unitCost * Number(base.quantity || 0),
    cost_source: unitCost == null ? null : existing?.cost_source || catalogCostSource,
    catalog_sync_status: status,
    catalog_error: status === "missing_vendor_price"
      ? "Product has no Vendor Price"
      : status === "historical_cost_review"
        ? "Current Vendor Price was found but was not applied to this historical item"
        : null,
    cost_snapshot_at: unitCost == null ? null :
      existing?.cost_snapshot_at || new Date().toISOString(),
  };
}

function saveLine(line) {
  getDb().prepare(UPSERT_SQL).run({
    catalog_product_id: null, image_url_snapshot: null, supplier_id: null,
    supplier_key: null, merchant_code: null, unit_supplier_cost_usd: null,
    total_supplier_cost_usd: null, cost_source: null, catalog_error: null,
    cost_snapshot_at: null, ...line,
  });
}

function processOrderItems(order) {
  const db = getDb();
  const code = String(order.code || "");
  const existingRows = db.prepare("SELECT * FROM order_items WHERE order_code=?").all(code);
  const byKey = new Map(existingRows.map((row) => [row.line_key, row]));
  const enriched = aggregateOrderDetails(order).map((line) =>
    enrichLine(line, byKey.get(line.line_key))
  );
  db.transaction(() => {
    for (const line of enriched) saveLine(line);
    const keys = new Set(enriched.map((line) => line.line_key));
    for (const old of existingRows) {
      if (!keys.has(old.line_key)) db.prepare("DELETE FROM order_items WHERE id=?").run(old.id);
    }
  })();
  return getOrderItems(code);
}

function getOrderItems(orderCode) {
  return getDb().prepare("SELECT * FROM order_items WHERE order_code=? ORDER BY id")
    .all(String(orderCode || ""));
}

function getOrderItemsMap() {
  const map = new Map();
  for (const row of getDb().prepare("SELECT * FROM order_items ORDER BY order_code,id").all()) {
    if (!map.has(row.order_code)) map.set(row.order_code, []);
    map.get(row.order_code).push(row);
  }
  return map;
}

function getLatestSyncedImagesByBarcode() {
  const rows = getDb().prepare(`
    SELECT barcode, image_url_snapshot
    FROM order_items
    WHERE barcode IS NOT NULL AND TRIM(barcode) <> ''
      AND image_url_snapshot IS NOT NULL AND TRIM(image_url_snapshot) <> ''
    ORDER BY datetime(updated_at) DESC, id DESC
  `).all();
  const images = new Map();
  for (const row of rows) {
    if (!images.has(row.barcode)) images.set(row.barcode, row.image_url_snapshot);
  }
  return images;
}

function retryPendingItems({ recentWindowDays = 7 } = {}) {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM order_items WHERE catalog_sync_status IN " +
    "('pending','error','missing_product','missing_vendor_price','historical_cost_review') ORDER BY order_code,id"
  ).all();
  const orderCodes = new Set();
  let historicalCostReview = 0;
  const recentThreshold = Date.now() - Number(recentWindowDays || 7) * 86400000;
  db.transaction(() => {
    for (const row of rows) {
      const orderTime = Date.parse(row.order_created_at || "");
      const allowCostSnapshot = Number.isFinite(orderTime) && orderTime >= recentThreshold;
      const next = enrichLine(row, row, { allowCostSnapshot });
      saveLine(next);
      if (next.catalog_sync_status === "matched") orderCodes.add(row.order_code);
      if (next.catalog_sync_status === "historical_cost_review") historicalCostReview += 1;
    }
  })();
  return {
    attempted: rows.length,
    order_codes: Array.from(orderCodes),
    historical_cost_review: historicalCostReview,
  };
}

const BACKFILL_STATUSES = [
  "pending", "error", "missing_product", "missing_vendor_price", "historical_cost_review",
];

function getBackfillRows(db = getDb()) {
  return db.prepare(
    `SELECT * FROM order_items
     WHERE catalog_sync_status IN (${BACKFILL_STATUSES.map(() => "?").join(",")})
     ORDER BY order_created_at, order_code, id`
  ).all(...BACKFILL_STATUSES);
}

function getBackfillPreview() {
  const db = getDb();
  const rows = getBackfillRows(db);
  const counts = Object.fromEntries(BACKFILL_STATUSES.map((status) => [status, 0]));
  let metadataCandidates = 0;
  let currentPriceCandidates = 0;
  for (const row of rows) {
    counts[row.catalog_sync_status] = Number(counts[row.catalog_sync_status] || 0) + 1;
    const product = row.barcode ? catalogCache.getProductByBarcode(row.barcode) : null;
    if (product) metadataCandidates += 1;
    if (product?.vendor_price_usd != null || product?.legacy_cost_usd != null) {
      currentPriceCandidates += 1;
    }
  }
  const legacySales = db.prepare(`
    SELECT COUNT(*) AS count FROM sales
    WHERE catalog_product_id IS NULL AND barcode IS NOT NULL AND barcode != ''
  `).get();
  return {
    total_candidates: rows.length,
    metadata_candidates: metadataCandidates,
    current_price_candidates: currentPriceCandidates,
    legacy_sales_without_catalog_snapshot: Number(legacySales?.count || 0),
    by_status: counts,
  };
}

function syncSaleMetadata(db, line) {
  if (!line.barcode) return;
  db.prepare(`
    UPDATE sales SET
      catalog_product_id = COALESCE(catalog_product_id, ?),
      item_name_snapshot = COALESCE(item_name_snapshot, ?),
      image_url_snapshot = COALESCE(image_url_snapshot, ?),
      supplier_id = COALESCE(supplier_id, ?),
      merchant_code = COALESCE(merchant_code, ?),
      catalog_sync_status = ?
    WHERE order_code = ? AND barcode = ?
  `).run(
    line.catalog_product_id || null, line.item_name_snapshot || null,
    line.image_url_snapshot || null, line.supplier_id || null,
    line.merchant_code || null, line.catalog_sync_status,
    line.order_code, line.barcode
  );
}

function backfillMissingProductData({ applyCurrentVendorPrice = false } = {}) {
  const db = getDb();
  const rows = getBackfillRows(db);
  const orderCodes = new Set();
  const result = {
    attempted: rows.length, metadata_updated: 0, costs_snapshotted: 0,
    still_missing_product: 0, missing_vendor_price: 0, historical_cost_review: 0,
    order_codes: [], apply_current_vendor_price: !!applyCurrentVendorPrice,
  };
  db.transaction(() => {
    for (const row of rows) {
      const next = enrichLine(row, row, { allowCostSnapshot: !!applyCurrentVendorPrice });
      saveLine(next);
      syncSaleMetadata(db, next);
      if (next.catalog_product_id) result.metadata_updated += 1;
      if (next.catalog_sync_status === "matched" && next.cost_snapshot_at) {
        result.costs_snapshotted += 1;
        orderCodes.add(next.order_code);
      }
      if (next.catalog_sync_status === "missing_product") result.still_missing_product += 1;
      if (next.catalog_sync_status === "missing_vendor_price") result.missing_vendor_price += 1;
      if (next.catalog_sync_status === "historical_cost_review") result.historical_cost_review += 1;
    }
  })();
  result.order_codes = Array.from(orderCodes);
  return result;
}

module.exports = {
  aggregateOrderDetails, enrichLine, getOrderItems, getOrderItemsMap,
  getLatestSyncedImagesByBarcode,
  backfillMissingProductData, getBackfillPreview, processOrderItems, retryPendingItems,
};
