const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const database = require("../src/db/database");
const catalogCache = require("../src/db/productCatalogCache");
const walletDb = require("../src/db/wallet");
const suppliersDb = require("../src/db/suppliers");
const { createProductCatalogService } = require("../src/services/productCatalogService");

const {
  buildImport,
  inferCatalogStatus,
  parseAnnotatedNumber,
} = require("../scripts/import-google-sheet-products");

const HEADERS = [
  "f", "Cost", "vander price", "high price", "quantity", "item_name", "barcode",
  "description", "measurement_unit", "measurement_value", "brand_name", "image1_url",
  "image2_url", "image3_url", "image4_url", "category", "subcategory", "sku",
  "model_name", "color", "Merchants", "Product ID", "Updated", "Created", "Status",
];

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function makeCsv(rows) {
  return [HEADERS, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function makeRow(overrides = {}) {
  const values = {
    Cost: "$4.00",
    "vander price": "$5.00",
    "high price": "10.75",
    quantity: "38",
    item_name: "MICRO SDHC CARD SANDISK ",
    barcode: "619659052775",
    image1_url: "https://example.com/product.jpg",
    category: "Mobile + Accessories",
    sku: "016G-B35",
    Merchants: "B",
    "Product ID": "PRD-000298",
    ...overrides,
  };
  return HEADERS.map((header) => values[header] ?? "");
}

function createDatabase() {
  database.closeDatabase();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-profit-catalog-test-"));
  database.initDatabase(directory);
  return database.getDb();
}

test.afterEach(() => database.closeDatabase());

test("Sheet importer maps the exact SanDisk scenario without trimming its item name", () => {
  const result = buildImport(makeCsv([makeRow()]));
  assert.equal(result.summary.readyForUpsert, 1);
  assert.equal(result.summary.missingVendorPrice, 0);
  assert.deepEqual(result.products[0], {
    barcode: "619659052775",
    item_name: "MICRO SDHC CARD SANDISK ",
    sku: "016G-B35",
    brand: null,
    category: "Mobile + Accessories",
    sub_category: null,
    description: null,
    model_name: null,
    color: null,
    measurement_unit: null,
    measurement_value: null,
    selling_price_usd: 10.75,
    vendor_price_usd: 5,
    legacy_cost_usd: 4,
    merchant_code: "B",
    image_url: "https://example.com/product.jpg",
    image_urls: ["https://example.com/product.jpg"],
    stock_quantity: 38,
    is_available: true,
    is_archived: false,
    stock_status: "in_stock",
    source_product_id: "PRD-000298",
    source_status: null,
    source_created_at: null,
    source_updated_at: null,
    import_source_raw: Object.fromEntries(
      HEADERS.map((header, index) => [header, makeRow()[index]])
    ),
  });
});

test("barcodes remain text and duplicate rows collapse to the later value", () => {
  const result = buildImport(makeCsv([
    makeRow({ barcode: " 00123456789012345678 ", "vander price": "5" }),
    makeRow({ barcode: "00123456789012345678", "vander price": "6" }),
  ]));
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].barcode, "00123456789012345678");
  assert.equal(result.products[0].vendor_price_usd, 6);
  assert.equal(result.summary.duplicateBarcode, 1);
});

test("annotated prices parse but invalid and missing vendor prices remain null", () => {
  assert.deepEqual(parseAnnotatedNumber("20 @"), { value: 20, valid: true, missing: false });
  assert.deepEqual(parseAnnotatedNumber("$5.50"), { value: 5.5, valid: true, missing: false });
  assert.deepEqual(parseAnnotatedNumber("NNN"), { value: null, valid: false, missing: false });
  assert.deepEqual(parseAnnotatedNumber(""), { value: null, valid: true, missing: true });

  const result = buildImport(makeCsv([
    makeRow({ "vander price": "NNN", Merchants: "Unknown" }),
  ]));
  assert.equal(result.products[0].vendor_price_usd, null);
  assert.equal(result.products[0].merchant_code, null);
  assert.equal(result.summary.missingVendorPrice, 1);
  assert.equal(result.summary.invalidVendorPrice, 1);
  assert.equal(result.summary.unknownMerchant, 1);
});

test("availability and archive status are separate concepts", () => {
  assert.deepEqual(inferCatalogStatus("", 0), {
    is_available: false,
    is_archived: false,
    stock_status: "out_of_stock",
  });
  assert.deepEqual(inferCatalogStatus("Archived", 5), {
    is_available: false,
    is_archived: true,
    stock_status: "out_of_stock",
  });
});

test("Supabase catalog migration intentionally supports archive instead of delete", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "..", "supabase", "migrations", "20260901_product_catalog.sql"),
    "utf8"
  );
  assert.match(migration, /barcode text not null unique/i);
  assert.match(migration, /vendor_price_usd numeric/i);
  assert.match(migration, /is_archived boolean not null default false/i);
  assert.doesNotMatch(migration, /grant\s+delete/i);
  assert.match(migration, /\('B', 'bassam', 'Bassam'\)/);
  assert.match(migration, /\('T', 'ahmad', 'Ahmad'\)/);
});

test("catalog cache resolves Merchant to the stable supplier mapping", () => {
  createDatabase();
  const result = catalogCache.replaceCatalog([
    {
      id: "product-1",
      barcode: "619659052775",
      item_name: "SanDisk",
      vendor_price_usd: 5,
      merchant_code: "B",
      image_urls: ["https://example.com/sandisk.jpg"],
      is_available: true,
      is_archived: false,
      stock_status: "in_stock",
      updated_at: "2026-09-01T10:00:00.000Z",
    },
  ], [
    { merchant_code: "B", supplier_key: "bassam", supplier_name: "Bassam" },
  ]);

  assert.deepEqual(result, { products: 1, mappings: 1 });
  const product = catalogCache.getProductByBarcode(" 619659052775 ");
  assert.equal(product.vendor_price_usd, 5);
  assert.equal(product.supplier_key, "bassam");
  assert.equal(product.supplier_name, "Bassam");
  assert.deepEqual(product.image_urls, ["https://example.com/sandisk.jpg"]);
  assert.equal(product._catalog_source, "cache");
});

test("catalog cache is explicitly excluded from the shared historical snapshot", () => {
  createDatabase();
  catalogCache.replaceCatalog([
    { id: "product-1", barcode: "ABC", item_name: "Cached product" },
  ], []);
  const snapshot = walletDb.collectBackupData();
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, "product_catalog_cache"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, "catalog_merchant_supplier_cache"), false);
});

test("catalog service refreshes cache and falls back to it when Supabase is offline", async () => {
  createDatabase();
  let offline = false;
  const cloud = {
    async requestAuthenticated(pathname) {
      if (offline) throw new Error("network unavailable");
      if (pathname.startsWith("/rest/v1/merchant_supplier_mapping?")) {
        return [{ merchant_code: "B", supplier_key: "bassam", supplier_name: "Bassam" }];
      }
      return [{
        id: "product-1",
        barcode: "619659052775",
        item_name: "SanDisk",
        vendor_price_usd: 5,
        merchant_code: "B",
        merchant_supplier_mapping: { supplier_key: "bassam", supplier_name: "Bassam" },
      }];
    },
  };
  const service = createProductCatalogService({ cloud, cache: catalogCache });
  const refreshed = await service.refreshCache();
  assert.equal(refreshed.products, 1);

  offline = true;
  const product = await service.getProductByBarcode("619659052775");
  assert.equal(product._catalog_source, "cache");
  assert.equal(product.vendor_price_usd, 5);
  assert.match(product._catalog_error, /network unavailable/);
});

test("catalog service rejects negative price changes before calling Supabase", async () => {
  createDatabase();
  let requests = 0;
  const service = createProductCatalogService({
    cloud: {
      async requestAuthenticated() {
        requests += 1;
        return [];
      },
    },
    cache: catalogCache,
  });
  await assert.rejects(() => service.updateVendorPrice("product-1", -1), /non-negative/);
  assert.equal(requests, 0);
});

test("Products page uses the central catalog and remains usable as mobile cards", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "render", "products.html"),
    "utf8"
  );
  assert.match(html, /catalogGetProducts/);
  assert.match(html, /catalogRefreshCache/);
  assert.match(html, /catalogArchiveProduct/);
  assert.match(html, /catalogRestoreProduct/);
  assert.match(html, /catalogSetStock/);
  assert.match(html, /Vendor Price USD/);
  assert.match(html, /All suppliers/);
  assert.match(html, /Show archived/);
  assert.match(html, /@media\(max-width:720px\)/);
  assert.match(html, /td:before\{content:attr\(data-label\)/);
  assert.match(html, /No image/);
  assert.match(html, /Image URLs/);
  assert.match(html, /synced_order_image_url/);
  assert.match(html, /target="_blank"/);
});

test("Merchant mapping attaches to an existing supplier instead of creating a duplicate", () => {
  const db = createDatabase();
  const existing = suppliersDb.createSupplier({ name: "bassam" }).supplier;
  catalogCache.replaceCatalog([], [
    { merchant_code: "B", supplier_key: "bassam", supplier_name: "Bassam" },
  ]);
  const rows = db.prepare(
    "SELECT id, name, catalog_supplier_key FROM suppliers ORDER BY id"
  ).all();
  assert.deepEqual(rows, [{ id: existing.id, name: "bassam", catalog_supplier_key: "bassam" }]);
  assert.equal(suppliersDb.getSupplierByCatalogKey("BASSAM").id, existing.id);
});

test("catalog supplier identity survives JSON backup restore", () => {
  createDatabase();
  const supplier = suppliersDb.resolveCatalogSupplier({
    supplier_key: "ahmad",
    supplier_name: "Ahmad",
  });
  const backup = walletDb.collectBackupData();
  database.getDb().prepare("DELETE FROM suppliers").run();
  const restored = walletDb.importBackupData(backup, { replace: true });
  assert.equal(restored.ok, true);
  assert.equal(suppliersDb.getSupplierByCatalogKey("ahmad").id, supplier.id);
});
