const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

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
