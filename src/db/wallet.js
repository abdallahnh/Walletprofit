const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { getDb, getDbPath, replaceDatabaseFromFile } = require("./database");

const BACKUP_SCHEMA_VERSION = 3;

function extractOrderCode(reason) {
  if (!reason) return null;
  const m = String(reason).match(/order\s+(\d{3,}-\d{3,})/i);
  return m ? m[1] : null;
}

function normalizeType(type) {
  const t = (type || "").trim().toLowerCase();

  if (t === "gross_app_revenue") return "gross";
  if (t === "store_listing_fee") return "service_fee";
  if (t === "value_added_tax") return "vat";
  if (t === "merchant_incentive") return "incentive";
  if (t === "balance_settlement") return "settlement";
  if (t === "marketing_immediate_discount") return "marketing";

  if (t.includes("gross")) return "gross";
  if (t.includes("store listing") || t.includes("service fee")) return "service_fee";
  if (t.includes("value added") || t.includes("vat")) return "vat";
  if (t.includes("merchant incentive") || t.includes("cashback")) return "incentive";
  if (t.includes("balance settlement") || t.includes("settlement")) return "settlement";
  if (t.includes("marketing")) return "marketing";

  return "other";
}

/** Wallet gross sign: negative = collected for merchant, positive = refund/deduction to client. */
function grossAmountToMerchant(amt) {
  return -(Number(amt) || 0);
}

function parseWalletTsv(text) {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows = [];

  for (const line of lines) {
    if (/^id[\s,]+amount[\s,]+reason/i.test(line)) continue;

    let parts = line.split("\t").map((s) => s.trim());
    if (parts.length < 5) {
      parts = parseCsvLine(line);
    }
    if (parts.length < 5) parts = line.split(/\s{2,}/).map((s) => s.trim());
    if (parts.length < 5) continue;

    const id = Number(parts[0]);
    const amount = Number(String(parts[1]).replace(/,/g, ""));
    const reason = parts[2];
    const type = parts[3];
    const date = parts[4];

    if (!Number.isFinite(id) || !Number.isFinite(amount)) continue;
    rows.push({ id, amount, reason, type, created_at: date });
  }

  return rows;
}

function parseCsvLine(line) {
  const parts = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

function importWalletFromFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return importWalletTsv(text);
}

function importWalletTsv(text) {
  const db = getDb();
  const rows = parseWalletTsv(text);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO transactions(id, store_id, amount, wallet, reason, type, created_at, order_code)
    VALUES(@id, @store_id, @amount, @wallet, @reason, @type, @created_at, @order_code)
  `);

  const insertMany = db.transaction((items) => {
    let inserted = 0;
    let ignored = 0;

    for (const r of items) {
      const order_code = extractOrderCode(r.reason);
      const info = stmt.run({
        id: r.id,
        store_id: r.store_id || null,
        amount: Math.trunc(r.amount),
        wallet: r.wallet || null,
        reason: r.reason || "",
        type: r.type || "",
        created_at: r.created_at || "",
        order_code,
      });
      if (info.changes === 1) inserted++;
      else ignored++;
    }

    return { inserted, ignored };
  });

  return insertMany(rows);
}

function getWalletConfig() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM config WHERE key=?").get("walletConfig");
  try {
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

function saveWalletConfig(cfg) {
  const db = getDb();
  const safe = {
    baseUrl: String(cfg.baseUrl || "https://dashboard.toters-api.com").trim(),
    storeId: String(cfg.storeId || "").trim(),
    wallet: String(cfg.wallet || "main").trim() || "main",
    token: String(cfg.token || "").trim(),
    usdToLbpRate: Number(cfg.usdToLbpRate || 90000),
    displayCurrency: String(cfg.displayCurrency || "USD").toUpperCase(),
  };

  db.prepare(
    "INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run("walletConfig", JSON.stringify(safe));

  return { ok: true };
}

async function syncWallet() {
  const db = getDb();
  const cfg = getWalletConfig();
  if (!cfg?.baseUrl || !cfg?.storeId || !cfg?.token) {
    return { ok: false, error: "Missing config: baseUrl/storeId/token (open Wallet Settings)" };
  }

  let nextUrl = `${cfg.baseUrl}/api/stores/${cfg.storeId}/wallet/all?page=1&wallet=${encodeURIComponent(
    cfg.wallet || "main"
  )}`;
  let totalFetched = 0;
  let totalInserted = 0;
  let totalIgnored = 0;
  let pages = 0;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO transactions(id, store_id, amount, wallet, reason, type, created_at, order_code)
    VALUES(@id, @store_id, @amount, @wallet, @reason, @type, @created_at, @order_code)
  `);

  const insertMany = db.transaction((items) => {
    let inserted = 0,
      ignored = 0;
    for (const it of items) {
      const order_code = extractOrderCode(it.reason);
      const info = stmt.run({
        id: it.id,
        store_id: it.store_id ?? null,
        amount: Math.trunc(it.amount || 0),
        wallet: it.wallet || null,
        reason: it.reason || "",
        type: it.type || "",
        created_at: it.created_at || "",
        order_code,
      });
      if (info.changes === 1) inserted++;
      else ignored++;
    }
    return { inserted, ignored };
  });

  while (nextUrl) {
    pages += 1;

    const resp = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return { ok: false, error: `Fetch failed (${resp.status}): ${txt.slice(0, 240)}` };
    }

    const json = await resp.json();
    const wallet = json?.data?.wallet;
    const items = wallet?.data || [];

    if (!Array.isArray(items) || items.length === 0) break;

    const res = insertMany(items);
    totalFetched += items.length;
    totalInserted += res.inserted;
    totalIgnored += res.ignored;

    if (wallet?.next_page_url) {
      const u = new URL(wallet.next_page_url);
      u.searchParams.set("wallet", cfg.wallet || "main");
      nextUrl = u.toString();
    } else {
      nextUrl = null;
    }

    if (pages > 500) break;
  }

  return { ok: true, pages, totalFetched, totalInserted, totalIgnored };
}

function collectBackupData() {
  const db = getDb();

  return {
    schema_version: BACKUP_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    transactions: db.prepare("SELECT * FROM transactions ORDER BY id ASC").all(),
    suppliers: db.prepare("SELECT * FROM suppliers ORDER BY id ASC").all(),
    order_meta: db.prepare("SELECT * FROM order_meta ORDER BY order_code ASC").all(),
    products: db.prepare("SELECT * FROM products ORDER BY id ASC").all(),
    sales: db.prepare("SELECT * FROM sales ORDER BY id ASC").all(),
    product_price_history: db
      .prepare("SELECT * FROM product_price_history ORDER BY id ASC")
      .all(),
    walletConfig: getWalletConfig(),
    config: db.prepare("SELECT * FROM config ORDER BY key ASC").all(),
  };
}

function exportBackupJson(destPath) {
  const out = collectBackupData();
  const outPath =
    destPath || path.join(path.dirname(getDbPath()), "wallet-profit-backup.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  return outPath;
}

async function exportSqliteBackup(destPath) {
  const db = getDb();
  const outPath =
    destPath || path.join(path.dirname(getDbPath()), "wallet-profit-backup.db");
  await db.backup(outPath);
  return outPath;
}

function validateBackupJson(data) {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Invalid backup file: not a JSON object" };
  }
  if (!Array.isArray(data.transactions)) {
    return { valid: false, error: "Invalid backup file: missing transactions array" };
  }
  return { valid: true };
}

function validateSqliteBackup(filePath) {
  if (!fs.existsSync(filePath)) {
    return { valid: false, error: "Backup file not found" };
  }
  try {
    const probe = new Database(filePath, { readonly: true, fileMustExist: true });
    const tables = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    probe.close();

    const required = ["transactions", "order_meta", "products", "sales"];
    const missing = required.filter((t) => !tables.includes(t));
    if (missing.length) {
      return {
        valid: false,
        error: `Invalid SQLite backup: missing tables (${missing.join(", ")})`,
      };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, error: `Invalid SQLite backup: ${String(e.message || e)}` };
  }
}

function clearAllData() {
  const db = getDb();
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM sales;
    DELETE FROM product_price_history;
    DELETE FROM order_meta;
    DELETE FROM transactions;
    DELETE FROM products;
    DELETE FROM suppliers;
    DELETE FROM config;
    PRAGMA foreign_keys = ON;
  `);
}

function importBackupData(data, { replace = false } = {}) {
  const validation = validateBackupJson(data);
  if (!validation.valid) return { ok: false, error: validation.error };

  const db = getDb();
  const tx = data.transactions;
  const suppliers = Array.isArray(data.suppliers) ? data.suppliers : [];
  const meta = Array.isArray(data.order_meta) ? data.order_meta : [];
  const products = Array.isArray(data.products) ? data.products : [];
  const sales = Array.isArray(data.sales) ? data.sales : [];
  const priceHistory = Array.isArray(data.product_price_history)
    ? data.product_price_history
    : [];
  const walletConfig = data.walletConfig || null;
  const configRows = Array.isArray(data.config) ? data.config : [];

  const insertSupplier = db.prepare(`
    INSERT INTO suppliers (id, name, color, phone, created_at)
    VALUES (@id, @name, @color, @phone, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      color = excluded.color,
      phone = excluded.phone
  `);

  const insertTx = db.prepare(`
    INSERT OR IGNORE INTO transactions(id, store_id, amount, wallet, reason, type, created_at, order_code)
    VALUES(@id, @store_id, @amount, @wallet, @reason, @type, @created_at, @order_code)
  `);

  const insertMeta = db.prepare(`
    INSERT INTO order_meta(order_code, supplier_cost, supplier_paid, supplier_id, has_adjusted_items, adjusted_items_count, updated_at)
    VALUES(@order_code, @supplier_cost, @supplier_paid, @supplier_id, @has_adjusted_items, @adjusted_items_count, datetime('now'))
    ON CONFLICT(order_code) DO UPDATE SET
      supplier_cost=excluded.supplier_cost,
      supplier_paid=excluded.supplier_paid,
      supplier_id=excluded.supplier_id,
      has_adjusted_items=excluded.has_adjusted_items,
      adjusted_items_count=excluded.adjusted_items_count,
      updated_at=datetime('now')
  `);

  const insertProduct = db.prepare(`
    INSERT INTO products (
      id, barcode, item_name, sku, brand, store_name, item_id, source_id,
      category, category_id, sub_category, sub_category_id,
      unit_price_usd, cost_usd, measurement_unit, measurement_value,
      description, image_url, alt_barcodes, import_price_usd,
      stock_quantity, created_at, updated_at
    )
    VALUES (
      @id, @barcode, @item_name, @sku, @brand, @store_name, @item_id, @source_id,
      @category, @category_id, @sub_category, @sub_category_id,
      @unit_price_usd, @cost_usd, @measurement_unit, @measurement_value,
      @description, @image_url, @alt_barcodes, @import_price_usd,
      @stock_quantity, @created_at, @updated_at
    )
    ON CONFLICT(barcode) DO UPDATE SET
      item_name = excluded.item_name,
      sku = excluded.sku,
      brand = excluded.brand,
      store_name = excluded.store_name,
      category = excluded.category,
      sub_category = excluded.sub_category,
      unit_price_usd = excluded.unit_price_usd,
      cost_usd = excluded.cost_usd,
      measurement_unit = excluded.measurement_unit,
      measurement_value = excluded.measurement_value,
      description = excluded.description,
      image_url = excluded.image_url,
      alt_barcodes = excluded.alt_barcodes,
      import_price_usd = excluded.import_price_usd,
      stock_quantity = excluded.stock_quantity,
      updated_at = excluded.updated_at
  `);

  const insertSale = db.prepare(`
    INSERT INTO sales (
      id, order_code, barcode, product_id, quantity,
      unit_price, cost, total_sale, profit, created_at
    )
    VALUES (
      @id, @order_code, @barcode, @product_id, @quantity,
      @unit_price, @cost, @total_sale, @profit, @created_at
    )
    ON CONFLICT(id) DO UPDATE SET
      order_code = excluded.order_code,
      barcode = excluded.barcode,
      product_id = excluded.product_id,
      quantity = excluded.quantity,
      unit_price = excluded.unit_price,
      cost = excluded.cost,
      total_sale = excluded.total_sale,
      profit = excluded.profit,
      created_at = excluded.created_at
  `);

  const insertPriceHistory = db.prepare(`
    INSERT INTO product_price_history (id, product_id, barcode, unit_price_usd, cost_usd, effective_at)
    VALUES (@id, @product_id, @barcode, @unit_price_usd, @cost_usd, @effective_at)
    ON CONFLICT(id) DO UPDATE SET
      product_id = excluded.product_id,
      barcode = excluded.barcode,
      unit_price_usd = excluded.unit_price_usd,
      cost_usd = excluded.cost_usd,
      effective_at = excluded.effective_at
  `);

  const insertConfig = db.prepare(`
    INSERT INTO config (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const txn = db.transaction(() => {
    if (replace) clearAllData();

    for (const s of suppliers) {
      insertSupplier.run({
        id: s.id,
        name: s.name,
        color: s.color || "#e8f4fc",
        phone: s.phone || "",
        created_at: s.created_at || new Date().toISOString(),
      });
    }

    for (const r of tx) {
      insertTx.run({
        id: r.id,
        store_id: r.store_id ?? null,
        amount: Math.trunc(r.amount || 0),
        wallet: r.wallet ?? null,
        reason: r.reason || "",
        type: r.type || "",
        created_at: r.created_at || "",
        order_code: r.order_code || extractOrderCode(r.reason),
      });
    }

    for (const m of meta) {
      insertMeta.run({
        order_code: m.order_code,
        supplier_cost: Math.trunc(m.supplier_cost || 0),
        supplier_paid: m.supplier_paid ? 1 : 0,
        supplier_id: m.supplier_id ?? null,
        has_adjusted_items: m.has_adjusted_items ? 1 : 0,
        adjusted_items_count: Math.trunc(m.adjusted_items_count || 0),
      });
    }

    for (const p of products) {
      insertProduct.run({
        id: p.id,
        barcode: p.barcode,
        item_name: p.item_name,
        sku: p.sku,
        brand: p.brand,
        store_name: p.store_name ?? null,
        item_id: p.item_id ?? null,
        source_id: p.source_id ?? null,
        category: p.category,
        category_id: p.category_id ?? null,
        sub_category: p.sub_category,
        sub_category_id: p.sub_category_id ?? null,
        unit_price_usd: p.unit_price_usd,
        cost_usd: p.cost_usd,
        measurement_unit: p.measurement_unit,
        measurement_value: p.measurement_value,
        description: p.description,
        image_url: p.image_url,
        alt_barcodes: p.alt_barcodes ?? null,
        import_price_usd: p.import_price_usd ?? null,
        stock_quantity: p.stock_quantity,
        created_at: p.created_at,
        updated_at: p.updated_at,
      });
    }

    for (const s of sales) {
      insertSale.run({
        id: s.id,
        order_code: s.order_code,
        barcode: s.barcode,
        product_id: s.product_id,
        quantity: s.quantity,
        unit_price: s.unit_price,
        cost: s.cost,
        total_sale: s.total_sale,
        profit: s.profit,
        created_at: s.created_at,
      });
    }

    for (const h of priceHistory) {
      insertPriceHistory.run({
        id: h.id,
        product_id: h.product_id,
        barcode: h.barcode,
        unit_price_usd: h.unit_price_usd,
        cost_usd: h.cost_usd,
        effective_at: h.effective_at,
      });
    }

    if (configRows.length) {
      for (const c of configRows) {
        insertConfig.run({ key: c.key, value: c.value });
      }
    }

    if (walletConfig && typeof walletConfig === "object") saveWalletConfig(walletConfig);
  });

  txn();
  return {
    ok: true,
    imported_transactions: tx.length,
    imported_suppliers: suppliers.length,
    imported_meta: meta.length,
    imported_products: products.length,
    imported_sales: sales.length,
    imported_price_history: priceHistory.length,
    replaced: !!replace,
  };
}

function importBackupJsonFromFile(filePath, opts = {}) {
  const raw = fs.readFileSync(filePath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `Invalid JSON backup: ${String(e.message || e)}` };
  }
  return importBackupData(data, opts);
}

async function importSqliteBackupFromFile(filePath) {
  const validation = validateSqliteBackup(filePath);
  if (!validation.valid) return { ok: false, error: validation.error };

  try {
    replaceDatabaseFromFile(filePath);
    return { ok: true, replaced: true, format: "sqlite" };
  } catch (e) {
    return { ok: false, error: `SQLite restore failed: ${String(e.message || e)}` };
  }
}

function detectBackupFormat(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".db" || ext === ".sqlite" || ext === ".sqlite3") return "sqlite";
  if (ext === ".json") return "json";
  return null;
}

module.exports = {
  importWalletTsv,
  importWalletFromFile,
  getWalletConfig,
  saveWalletConfig,
  syncWallet,
  exportBackupJson,
  exportSqliteBackup,
  importBackupJsonFromFile,
  importSqliteBackupFromFile,
  importBackupData,
  validateBackupJson,
  validateSqliteBackup,
  detectBackupFormat,
  collectBackupData,
  BACKUP_SCHEMA_VERSION,
  extractOrderCode,
  normalizeType,
  grossAmountToMerchant,
};

