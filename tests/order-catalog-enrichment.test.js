const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const database = require("../src/db/database");
const catalogCache = require("../src/db/productCatalogCache");
const salesDb = require("../src/db/sales");
const orderItemsDb = require("../src/db/orderItems");
const orderLineMeta = require("../src/db/orderLineMeta");
const walletDb = require("../src/db/wallet");
const ordersDb = require("../src/db/orders");
const suppliersDb = require("../src/db/suppliers");

const mappings = [
  { merchant_code: "B", supplier_key: "bassam", supplier_name: "Bassam" },
  { merchant_code: "T", supplier_key: "ahmad", supplier_name: "Ahmad" },
];

function product(overrides = {}) {
  return {
    id: overrides.id || "product-sandisk",
    barcode: overrides.barcode || "619659052775",
    item_name: overrides.item_name || "SanDisk Micro SDHC Card",
    vendor_price_usd: overrides.vendor_price_usd === undefined ? 5 : overrides.vendor_price_usd,
    legacy_cost_usd: overrides.legacy_cost_usd === undefined ? null : overrides.legacy_cost_usd,
    selling_price_usd: 9.478,
    merchant_code: overrides.merchant_code || "B",
    image_url: overrides.image_url || "https://example.com/sandisk.jpg",
    is_available: overrides.is_available === undefined ? true : overrides.is_available,
    is_archived: !!overrides.is_archived,
    stock_status: overrides.stock_status || "in_stock",
  };
}

function order(code, items) {
  return {
    code,
    created_at: "2026-08-25T10:00:00.000Z",
    order_detail: items.map((item) => ({
      quantity: item.quantity,
      item_price: Number(item.price_usd || 10) * 90000,
      item: {
        barcode: item.barcode,
        item_name: item.item_name || "Toters item",
        ...(item.image_url ? { image: item.image_url } : {}),
      },
    })),
  };
}

function setup(products = [product()]) {
  database.closeDatabase();
  database.initDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "wallet-order-catalog-")));
  catalogCache.replaceCatalog(products, mappings);
  return database.getDb();
}

test.afterEach(() => database.closeDatabase());

test("catalog snapshot assigns Bassam, image, and $5 per sold unit", () => {
  const db = setup();
  const result = salesDb.recordOrderItemsToSales(order("40600-47008", [
    { barcode: "619659052775", quantity: 3 },
  ]));
  assert.equal(result.matched_items, 1);
  const item = orderItemsDb.getOrderItems("40600-47008")[0];
  assert.equal(item.unit_supplier_cost_usd, 5);
  assert.equal(item.total_supplier_cost_usd, 15);
  assert.equal(item.image_url_snapshot, "https://example.com/sandisk.jpg");
  assert.equal(item.catalog_sync_status, "matched");
  const sale = db.prepare("SELECT * FROM sales WHERE order_code=?").get("40600-47008");
  assert.equal(sale.cost, 15);
  assert.equal(sale.unit_supplier_cost_usd, 5);
  assert.equal(sale.cost_source, "catalog_snapshot");
  assert.equal(orderLineMeta.getOrderLineTotals("40600-47008").supplier_name, "Bassam");
});

test("Merchant T maps the item snapshot to the existing Ahmad supplier", () => {
  setup([product({ merchant_code: "T" })]);
  salesDb.recordOrderItemsToSales(order("40600-47009", [
    { barcode: "619659052775", quantity: 1 },
  ]));
  assert.equal(orderLineMeta.getOrderLineTotals("40600-47009").supplier_name, "Ahmad");
});

test("missing Vendor Price falls back to Cost and records a visible source flag", () => {
  const db = setup([product({ vendor_price_usd: null, legacy_cost_usd: 4 })]);
  salesDb.recordOrderItemsToSales(order("40600-47019", [
    { barcode: "619659052775", quantity: 3 },
  ]));
  const item = orderItemsDb.getOrderItems("40600-47019")[0];
  const sale = db.prepare("SELECT * FROM sales WHERE order_code=?").get("40600-47019");
  assert.equal(item.unit_supplier_cost_usd, 4);
  assert.equal(item.total_supplier_cost_usd, 12);
  assert.equal(item.catalog_sync_status, "matched");
  assert.equal(item.cost_source, "catalog_cost_fallback");
  assert.equal(sale.cost, 12);
  assert.equal(sale.cost_source, "catalog_cost_fallback");
});

test("Toters order-detail images override catalog images without changing cost snapshots", () => {
  const db = setup();
  salesDb.recordOrderItemsToSales(order("40600-47018", [
    { barcode: "619659052775", quantity: 1, image_url: "https://cdn.toters.example/first.jpg" },
  ]));
  let item = orderItemsDb.getOrderItems("40600-47018")[0];
  assert.equal(item.image_url_snapshot, "https://cdn.toters.example/first.jpg");
  assert.equal(item.unit_supplier_cost_usd, 5);

  catalogCache.replaceCatalog([product({ vendor_price_usd: 6 })], mappings);
  salesDb.recordOrderItemsToSales(order("40600-47018", [
    { barcode: "619659052775", quantity: 1, image_url: "https://cdn.toters.example/latest.jpg" },
  ]));
  item = orderItemsDb.getOrderItems("40600-47018")[0];
  const sale = db.prepare("SELECT cost, image_url_snapshot FROM sales WHERE order_code=?")
    .get("40600-47018");
  assert.equal(item.image_url_snapshot, "https://cdn.toters.example/latest.jpg");
  assert.equal(item.unit_supplier_cost_usd, 5);
  assert.equal(sale.cost, 5);
  assert.equal(sale.image_url_snapshot, "https://cdn.toters.example/latest.jpg");
  assert.equal(
    orderItemsDb.getLatestSyncedImagesByBarcode().get("619659052775"),
    "https://cdn.toters.example/latest.jpg"
  );
});

test("catalog price changes affect new sales but never rewrite an existing sale snapshot", () => {
  const db = setup();
  const oldOrder = order("40600-47010", [{ barcode: "619659052775", quantity: 1 }]);
  salesDb.recordOrderItemsToSales(oldOrder);
  catalogCache.replaceCatalog([product({ vendor_price_usd: 6 })], mappings);
  salesDb.recordOrderItemsToSales(oldOrder);
  salesDb.recordOrderItemsToSales(order("40600-47011", [
    { barcode: "619659052775", quantity: 1 },
  ]));
  assert.equal(db.prepare("SELECT cost FROM sales WHERE order_code=?").get("40600-47010").cost, 5);
  assert.equal(db.prepare("SELECT cost FROM sales WHERE order_code=?").get("40600-47011").cost, 6);
});

test("out-of-stock and archived products still enrich historical accounting", () => {
  setup([product({ is_available: false, is_archived: true, stock_status: "out_of_stock" })]);
  const result = salesDb.recordOrderItemsToSales(order("40600-47012", [
    { barcode: "619659052775", quantity: 1 },
  ]));
  assert.equal(result.matched_items, 1);
  assert.equal(orderItemsDb.getOrderItems("40600-47012")[0].total_supplier_cost_usd, 5);
});

test("one order allocates supplier costs independently for Bassam and Ahmad", () => {
  const db = setup([
    product(),
    product({ id: "product-ahmad", barcode: "AHMAD-7", item_name: "Ahmad item", vendor_price_usd: 7, merchant_code: "T" }),
    product({ id: "product-bassam-unsold", barcode: "BASSAM-UNSOLD", item_name: "Unsold Bassam item" }),
  ]);
  salesDb.recordOrderItemsToSales(order("40600-47013", [
    { barcode: "619659052775", quantity: 1 },
    { barcode: "AHMAD-7", quantity: 1 },
  ]));
  const totals = orderLineMeta.getOrderLineTotals("40600-47013");
  assert.equal(totals.is_multi_supplier, true);
  assert.deepEqual(new Set(totals.supplier_name.split(", ")), new Set(["Bassam", "Ahmad"]));
  assert.equal(totals.supplier_cost, 12 * 90000);
  db.prepare(`
    INSERT INTO transactions (id, amount, reason, type, created_at, order_code)
    VALUES (1, -1800000, 'Order 40600-47013', 'gross_app_revenue', '2026-08-25', '40600-47013')
  `).run();
  const summary = ordersDb.getSupplierSummary();
  assert.deepEqual(summary.map((row) => ({
    name: row.supplier_name,
    products: row.product_count,
    units: row.units_sold,
  })), [
    { name: "Ahmad", products: 1, units: 1 },
    { name: "Bassam", products: 1, units: 1 },
  ]);

  const bassam = db.prepare("SELECT id FROM suppliers WHERE catalog_supplier_key='bassam'").get();
  const ahmad = db.prepare("SELECT id FROM suppliers WHERE catalog_supplier_key='ahmad'").get();
  db.prepare(`
    UPDATE order_line_meta SET supplier_paid=1
    WHERE order_code='40600-47013' AND supplier_id=?
  `).run(bassam.id);
  const bassamDetails = suppliersDb.getSupplierDetails(bassam.id);
  assert.equal(bassamDetails.summary.catalog_products, 2);
  assert.equal(bassamDetails.summary.products_sold, 1);
  assert.equal(bassamDetails.summary.units_sold, 1);
  assert.equal(bassamDetails.summary.paid_amount_usd, 5);
  assert.equal(bassamDetails.summary.outstanding_usd, 0);
  assert.equal(bassamDetails.orders[0].supplier_paid, 1);
  const ahmadDetails = suppliersDb.getSupplierDetails(ahmad.id);
  assert.equal(ahmadDetails.summary.total_cost_usd, 7);
  assert.equal(ahmadDetails.summary.paid_amount_usd, 0);
  assert.equal(ahmadDetails.summary.outstanding_usd, 7);
});

test("missing product and missing Vendor Price stay explicit and never become zero cost", () => {
  const db = setup([product({ vendor_price_usd: null })]);
  salesDb.recordOrderItemsToSales(order("40600-47014", [
    { barcode: "619659052775", quantity: 1 },
    { barcode: "NOT-IN-CATALOG", quantity: 1 },
  ]));
  const rows = orderItemsDb.getOrderItems("40600-47014");
  assert.equal(rows.find((row) => row.barcode === "619659052775").catalog_sync_status, "missing_vendor_price");
  assert.equal(rows.find((row) => row.barcode === "NOT-IN-CATALOG").catalog_sync_status, "missing_product");
  const sale = db.prepare("SELECT cost, profit FROM sales WHERE order_code=?").get("40600-47014");
  assert.equal(sale.cost, null);
  assert.equal(sale.profit, null);
  assert.equal(orderLineMeta.getOrderLineTotals("40600-47014").has_lines, false);
  const reportRow = salesDb.getSalesReport().find((row) => row.barcode === "619659052775");
  assert.equal(reportRow.supplier_cost, null);
  assert.equal(reportRow.profit, null);
  assert.equal(reportRow.cost_status, "Missing Vendor Price");
  db.prepare(`
    INSERT INTO transactions (id, amount, reason, type, created_at, order_code)
    VALUES (1, -900000, 'Order 40600-47014', 'gross_app_revenue', '2026-08-25', '40600-47014')
  `).run();
  const reconciliation = ordersDb.getOrdersReconciliation()[0];
  assert.equal(reconciliation.has_unknown_supplier_cost, 1);
  assert.equal(reconciliation.net_profit, null);
  const period = ordersDb.getWalletRevenueByPeriod({ period: "day" })[0];
  assert.equal(period.profit, null);
  assert.equal(period.missing_cost_orders, 1);
  const bassam = db.prepare("SELECT id FROM suppliers WHERE catalog_supplier_key='bassam'").get();
  const details = suppliersDb.getSupplierDetails(bassam.id);
  assert.equal(details.summary.total_cost_usd, null);
  assert.equal(details.summary.missing_cost_items, 1);
  assert.equal(details.products[0].total_cost_usd, null);
});

test("cloud JSON backup round-trip preserves immutable item and sale snapshots", () => {
  let db = setup();
  salesDb.recordOrderItemsToSales(order("40600-47015", [
    { barcode: "619659052775", quantity: 2 },
  ]));
  const backup = walletDb.collectBackupData();
  assert.equal(backup.schema_version, 7);
  assert.equal(backup.order_items.length, 1);
  walletDb.importBackupData(backup, { replace: true });
  db = database.getDb();
  const item = db.prepare("SELECT * FROM order_items WHERE order_code=?").get("40600-47015");
  const sale = db.prepare("SELECT * FROM sales WHERE order_code=?").get("40600-47015");
  assert.equal(item.total_supplier_cost_usd, 10);
  assert.equal(item.cost_source, "catalog_snapshot");
  assert.equal(sale.total_supplier_cost_usd, 10);
  assert.equal(sale.supplier_id, item.supplier_id);
});

test("an existing manual order cost remains an explicit override during catalog enrichment", () => {
  const db = setup();
  const bassam = db.prepare("SELECT id FROM suppliers WHERE catalog_supplier_key='bassam'").get();
  db.prepare(`
    INSERT INTO order_meta (order_code, supplier_cost, supplier_paid, supplier_id, cost_source)
    VALUES (?, ?, 0, ?, 'manual_override')
  `).run("40600-47016", 8 * 90000, bassam.id);
  salesDb.recordOrderItemsToSales(order("40600-47016", [
    { barcode: "619659052775", quantity: 1 },
  ]));
  const sale = db.prepare("SELECT * FROM sales WHERE order_code=?").get("40600-47016");
  assert.equal(sale.cost, 8);
  assert.equal(sale.unit_supplier_cost_usd, 8);
  assert.equal(sale.cost_source, "manual_override");
  assert.equal(db.prepare("SELECT supplier_cost FROM order_meta WHERE order_code=?").get("40600-47016").supplier_cost, 8 * 90000);
});

test("safe historical backfill enriches metadata without applying today's Vendor Price", () => {
  const db = setup([]);
  db.prepare(`
    INSERT INTO sales (order_code, barcode, quantity, unit_price, cost, total_sale, profit, created_at)
    VALUES ('40600-47017', '619659052775', 1, 10, 4, 10, 6, '2026-01-01T10:00:00Z')
  `).run();
  salesDb.recordOrderItemsToSales(order("40600-47017", [
    { barcode: "619659052775", quantity: 1 },
  ]));
  catalogCache.replaceCatalog([product({ vendor_price_usd: 5 })], mappings);

  const retry = orderItemsDb.retryPendingItems({ recentWindowDays: 1 });
  assert.equal(retry.historical_cost_review, 1);
  assert.deepEqual(retry.order_codes, []);

  const preview = orderItemsDb.getBackfillPreview();
  assert.equal(preview.total_candidates, 1);
  assert.equal(preview.current_price_candidates, 1);
  const result = orderItemsDb.backfillMissingProductData({ applyCurrentVendorPrice: false });
  assert.equal(result.metadata_updated, 1);
  assert.equal(result.costs_snapshotted, 0);
  assert.equal(result.historical_cost_review, 1);
  const item = orderItemsDb.getOrderItems("40600-47017")[0];
  assert.equal(item.catalog_product_id, "product-sandisk");
  assert.equal(item.supplier_id != null, true);
  assert.equal(item.unit_supplier_cost_usd, null);
  assert.equal(item.catalog_sync_status, "historical_cost_review");
  const sale = db.prepare("SELECT cost, profit, catalog_product_id FROM sales WHERE order_code=?")
    .get("40600-47017");
  assert.equal(sale.cost, 4);
  assert.equal(sale.profit, 6);
  assert.equal(sale.catalog_product_id, "product-sandisk");
});

test("current Vendor Price is snapshotted only after explicit historical backfill opt-in", () => {
  const db = setup([]);
  salesDb.recordOrderItemsToSales(order("40600-47018", [
    { barcode: "619659052775", quantity: 2 },
  ]));
  catalogCache.replaceCatalog([product({ vendor_price_usd: 5 })], mappings);
  orderItemsDb.backfillMissingProductData({ applyCurrentVendorPrice: false });
  const result = orderItemsDb.backfillMissingProductData({ applyCurrentVendorPrice: true });
  assert.equal(result.costs_snapshotted, 1);
  assert.deepEqual(result.order_codes, ["40600-47018"]);
  salesDb.rebuildSalesFromStoredOrderItems("40600-47018");
  assert.equal(db.prepare("SELECT cost FROM sales WHERE order_code=?").get("40600-47018").cost, 10);
});
