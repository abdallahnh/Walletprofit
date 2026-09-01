#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const DEFAULT_SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1EQz8BZ2GfyT8t-gWaZdTYtuFK9A_yJ6Aofc4s553bsk/export?format=csv&gid=376649187";
const KNOWN_MERCHANTS = new Set(["B", "T"]);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    rows.push(row);
  }
  return rows;
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((value, index) =>
    index === 0 ? String(value || "").replace(/^\uFEFF/, "") : String(value || "")
  );
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]))
  );
}

function parseAnnotatedNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null, valid: true, missing: true };
  const normalized = raw.replace(/,/g, "");
  const match = normalized.match(/^\$?\s*(\d+(?:\.\d+)?)\s*(?:[*@-]+)?$/);
  if (!match) return { value: null, valid: false, missing: false };
  const number = Number(match[1]);
  return Number.isFinite(number) && number >= 0
    ? { value: number, valid: true, missing: false }
    : { value: null, valid: false, missing: false };
}

function parseSourceDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function inferCatalogStatus(sourceStatus, stockQuantity) {
  const status = String(sourceStatus || "").trim().toLowerCase();
  const isArchived = ["archived", "discontinued"].includes(status);
  const explicitlyUnavailable = ["inactive", "unavailable", "out of stock", "out_of_stock"].includes(status);
  const quantityOut = stockQuantity === 0;
  const isAvailable = !isArchived && !explicitlyUnavailable && !quantityOut;
  return {
    is_available: isAvailable,
    is_archived: isArchived,
    stock_status: isAvailable ? "in_stock" : "out_of_stock",
  };
}

function buildImport(csvText) {
  const sourceRows = rowsToObjects(parseCsv(csvText));
  const productsByBarcode = new Map();
  const warnings = [];
  const summary = {
    totalRows: sourceRows.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    invalidBarcode: 0,
    invalidItemName: 0,
    duplicateBarcode: 0,
    unknownMerchant: 0,
    missingVendorPrice: 0,
    invalidSellingPrice: 0,
    invalidVendorPrice: 0,
    invalidLegacyCost: 0,
    invalidQuantity: 0,
    readyForUpsert: 0,
  };

  for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex += 1) {
    const source = sourceRows[rowIndex];
    const sheetRow = rowIndex + 2;
    const barcode = String(source.barcode ?? "").trim();
    if (!barcode || !/[\p{L}\p{N}]/u.test(barcode)) {
      summary.invalidBarcode += 1;
      summary.skipped += 1;
      continue;
    }

    const itemName = String(source.item_name ?? "");
    if (!itemName.trim()) {
      summary.invalidItemName += 1;
      summary.skipped += 1;
      warnings.push({ sheetRow, barcode, field: "item_name", value: itemName });
      continue;
    }

    const selling = parseAnnotatedNumber(source["high price"]);
    const vendor = parseAnnotatedNumber(source["vander price"]);
    const legacyCost = parseAnnotatedNumber(source.Cost);
    const quantity = parseAnnotatedNumber(source.quantity);
    if (!selling.valid) summary.invalidSellingPrice += 1;
    if (!vendor.valid) summary.invalidVendorPrice += 1;
    if (!legacyCost.valid) summary.invalidLegacyCost += 1;
    if (!quantity.valid) summary.invalidQuantity += 1;
    if (vendor.value == null) summary.missingVendorPrice += 1;

    for (const [field, parsed, raw] of [
      ["high price", selling, source["high price"]],
      ["vander price", vendor, source["vander price"]],
      ["Cost", legacyCost, source.Cost],
      ["quantity", quantity, source.quantity],
    ]) {
      if (!parsed.valid) warnings.push({ sheetRow, barcode, field, value: raw });
    }

    const rawMerchant = String(source.Merchants ?? "").trim();
    const merchant = rawMerchant.toUpperCase();
    const merchantCode = KNOWN_MERCHANTS.has(merchant) ? merchant : null;
    if (rawMerchant && !merchantCode) {
      summary.unknownMerchant += 1;
      warnings.push({ sheetRow, barcode, field: "Merchants", value: rawMerchant });
    }

    const images = [source.image1_url, source.image2_url, source.image3_url, source.image4_url]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
    const status = inferCatalogStatus(source.Status, quantity.value);
    const product = {
      barcode,
      item_name: itemName,
      sku: String(source.sku ?? "").trim() || null,
      brand: String(source.brand_name ?? "").trim() || null,
      category: String(source.category ?? "").trim() || null,
      sub_category: String(source.subcategory ?? "").trim() || null,
      description: String(source.description ?? "") || null,
      model_name: String(source.model_name ?? "").trim() || null,
      color: String(source.color ?? "").trim() || null,
      measurement_unit: String(source.measurement_unit ?? "").trim() || null,
      measurement_value: String(source.measurement_value ?? "").trim() || null,
      selling_price_usd: selling.value,
      vendor_price_usd: vendor.value,
      legacy_cost_usd: legacyCost.value,
      merchant_code: merchantCode,
      image_url: images[0] || null,
      image_urls: images,
      stock_quantity: quantity.value,
      ...status,
      source_product_id: String(source["Product ID"] ?? "").trim() || null,
      source_status: String(source.Status ?? "").trim() || null,
      source_created_at: parseSourceDate(source.Created),
      source_updated_at: parseSourceDate(source.Updated),
      import_source_raw: source,
    };

    if (productsByBarcode.has(barcode)) {
      summary.duplicateBarcode += 1;
      summary.skipped += 1;
      warnings.push({ sheetRow, barcode, field: "barcode", value: "duplicate; later row used" });
    }
    productsByBarcode.set(barcode, product);
  }

  const products = Array.from(productsByBarcode.values());
  summary.readyForUpsert = products.length;
  return { products, summary, warnings };
}

function parseArgs(argv) {
  const options = { dryRun: false, csvPath: null, sheetUrl: DEFAULT_SHEET_CSV_URL };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--csv") options.csvPath = argv[++i];
    else if (arg === "--sheet-url") options.sheetUrl = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function readCsv(options, fetchImpl = global.fetch) {
  if (options.csvPath) return fs.readFileSync(options.csvPath, "utf8");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  const response = await fetchImpl(options.sheetUrl);
  if (!response.ok) throw new Error(`Google Sheet download failed (${response.status})`);
  return response.text();
}

let cachedSupabaseHeaders = null;

function supabaseBaseUrl() {
  const baseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  if (!baseUrl) throw new Error("SUPABASE_URL is required for a live import");
  return baseUrl;
}

async function supabaseHeaders(fetchImpl = global.fetch) {
  if (cachedSupabaseHeaders) return cachedSupabaseHeaders;
  const key = String(process.env.SUPABASE_KEY || "").trim();
  if (!key) throw new Error("SUPABASE_KEY is required for a live import");
  let accessToken = String(process.env.SUPABASE_ACCESS_TOKEN || "").trim();
  const email = String(process.env.SUPABASE_EMAIL || "").trim();
  const password = String(process.env.SUPABASE_PASSWORD || "");

  if (!accessToken && email && password) {
    const response = await fetchImpl(`${supabaseBaseUrl()}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      throw new Error(payload.error_description || payload.message || "Supabase sign-in failed");
    }
    accessToken = payload.access_token;
  }

  cachedSupabaseHeaders = {
    apikey: key,
    Authorization: `Bearer ${accessToken || key}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  return cachedSupabaseHeaders;
}

async function requestSupabase(path, options = {}, fetchImpl = global.fetch) {
  const response = await fetchImpl(supabaseBaseUrl() + path, {
    ...options,
    headers: { ...(await supabaseHeaders(fetchImpl)), ...(options.headers || {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function getExistingBarcodes(barcodes, fetchImpl = global.fetch) {
  const existing = new Set();
  for (let offset = 0; offset < barcodes.length; offset += 75) {
    const batch = barcodes.slice(offset, offset + 75);
    const inList = batch.map((barcode) => `"${String(barcode).replace(/"/g, '\\"')}"`).join(",");
    const rows = await requestSupabase(
      `/rest/v1/products?select=barcode&barcode=in.(${encodeURIComponent(inList)})`,
      {},
      fetchImpl
    );
    for (const row of rows || []) existing.add(String(row.barcode));
  }
  return existing;
}

async function upsertProducts(products, fetchImpl = global.fetch) {
  const existing = await getExistingBarcodes(products.map((p) => p.barcode), fetchImpl);
  for (let offset = 0; offset < products.length; offset += 100) {
    const batch = products.slice(offset, offset + 100);
    await requestSupabase("/rest/v1/products?on_conflict=barcode", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(batch),
    }, fetchImpl);
  }
  return {
    inserted: products.filter((p) => !existing.has(p.barcode)).length,
    updated: products.filter((p) => existing.has(p.barcode)).length,
  };
}

function helpText() {
  return [
    "One-time Google Sheet to Supabase product importer",
    "",
    "Dry run (recommended first):",
    "  node scripts/import-google-sheet-products.js --dry-run",
    "  node scripts/import-google-sheet-products.js --dry-run --csv products.csv",
    "",
    "Live import:",
    "  SUPABASE_URL=... SUPABASE_KEY=... SUPABASE_EMAIL=... SUPABASE_PASSWORD=... \\",
    "    node scripts/import-google-sheet-products.js",
    "",
    "Use an approved Supabase Auth account with the publishable key. A temporary",
    "SUPABASE_ACCESS_TOKEN or environment-only service-role key is also supported.",
    "Never add either credential to the repository.",
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText() + "\n");
    return;
  }
  const csv = await readCsv(options);
  const result = buildImport(csv);
  if (!options.dryRun) {
    Object.assign(result.summary, await upsertProducts(result.products));
  }
  process.stdout.write(JSON.stringify({
    mode: options.dryRun ? "dry-run" : "live",
    ...result.summary,
    warnings: result.warnings,
  }, null, 2) + "\n");
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Product import failed: ${String(error.message || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_SHEET_CSV_URL,
  buildImport,
  inferCatalogStatus,
  parseAnnotatedNumber,
  parseArgs,
  parseCsv,
  rowsToObjects,
  upsertProducts,
};
