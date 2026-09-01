const { getDb } = require("./database");
const catalogCache = require("./productCatalogCache");
const { getSupplierByCatalogKey } = require("./suppliers");
const { getWalletConfig } = require("./wallet");
const { normalizeOrderDetailItems } = require("../services/orderDetailItems");

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
      order_created_at: order.created_at || new Date().toISOString(),
    });
  });
  return Array.from(grouped.values());
}

function enrichLine(base, existing = null) {
  if (!base.barcode) return {
    ...base,
    catalog_sync_status: "missing_barcode",
    catalog_error: "Order item has no barcode",
    cost_source: existing?.cost_source || null,
  };
  const product = catalogCache.getProductByBarcode(base.barcode);
  if (!product) {
    const refreshed = catalogCache.hasSuccessfulRefresh();
    return {
      ...base,
      catalog_sync_status: refreshed ? "missing_product" : "pending",
      catalog_error: refreshed
        ? "Barcode does not exist in the product catalog"
        : "Product catalog cache has not been refreshed",
      cost_source: existing?.cost_source || null,
    };
  }
  const preserve = existing?.cost_source === "catalog_snapshot" &&
    existing?.unit_supplier_cost_usd != null;
  const unitCost = preserve ? Number(existing.unit_supplier_cost_usd) :
    product.vendor_price_usd == null ? null : Number(product.vendor_price_usd);
  const supplier = preserve && existing?.supplier_id
    ? { id: existing.supplier_id }
    : getSupplierByCatalogKey(product.supplier_key);
  const status = unitCost == null ? "missing_vendor_price" : "matched";
  return {
    ...base,
    item_name_snapshot: preserve ? existing.item_name_snapshot :
      product.item_name || base.item_name_snapshot,
    catalog_product_id: product.id,
    image_url_snapshot: preserve ? existing.image_url_snapshot : product.image_url || null,
    supplier_id: supplier?.id || existing?.supplier_id || null,
    supplier_key: preserve ? existing.supplier_key : product.supplier_key || null,
    merchant_code: preserve ? existing.merchant_code : product.merchant_code || null,
    unit_supplier_cost_usd: unitCost,
    total_supplier_cost_usd: unitCost == null ? null : unitCost * Number(base.quantity || 0),
    cost_source: unitCost == null ? null : existing?.cost_source || "catalog_snapshot",
    catalog_sync_status: status,
    catalog_error: status === "missing_vendor_price" ? "Product has no Vendor Price" : null,
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

function retryPendingItems() {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM order_items WHERE catalog_sync_status IN " +
    "('pending','error','missing_product','missing_vendor_price') ORDER BY order_code,id"
  ).all();
  const orderCodes = new Set();
  db.transaction(() => {
    for (const row of rows) {
      saveLine(enrichLine(row, row));
      orderCodes.add(row.order_code);
    }
  })();
  return { attempted: rows.length, order_codes: Array.from(orderCodes) };
}

module.exports = {
  aggregateOrderDetails, enrichLine, getOrderItems, getOrderItemsMap,
  processOrderItems, retryPendingItems,
};
