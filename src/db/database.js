const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

let db;
let dbPath;

function initDatabase(userDataPath) {
  if (db) return db;

  dbPath = path.join(userDataPath, "wallet-profit.sqlite");
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  migrateLegacyDatabase(userDataPath, dbPath);

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY,
      store_id INTEGER,
      amount INTEGER NOT NULL,
      wallet TEXT,
      reason TEXT,
      type TEXT,
      created_at TEXT,
      order_code TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_order_code ON transactions(order_code);
    CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color TEXT DEFAULT '#e8f4fc',
      phone TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_meta (
      order_code TEXT PRIMARY KEY,
      supplier_cost INTEGER DEFAULT 0,
      supplier_paid INTEGER DEFAULT 0,
      supplier_id INTEGER REFERENCES suppliers(id),
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barcode TEXT UNIQUE,
      item_name TEXT,
      sku TEXT,
      brand TEXT,
      store_name TEXT,
      item_id INTEGER,
      source_id INTEGER,
      category TEXT,
      category_id INTEGER,
      sub_category TEXT,
      sub_category_id INTEGER,
      unit_price_usd REAL,
      cost_usd REAL,
      measurement_unit TEXT,
      measurement_value TEXT,
      description TEXT,
      image_url TEXT,
      alt_barcodes TEXT,
      import_price_usd REAL,
      stock_quantity INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT,
      barcode TEXT,
      product_id INTEGER,
      quantity INTEGER,
      unit_price REAL,
      cost REAL,
      total_sale REAL,
      profit REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_sales_order_barcode
      ON sales(order_code, barcode);

    CREATE TABLE IF NOT EXISTS product_price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      barcode TEXT,
      unit_price_usd REAL,
      cost_usd REAL,
      effective_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_price_history_product_effective
      ON product_price_history(product_id, effective_at DESC);
  `);

  // Lightweight schema migrations for existing databases.
  ensureProductsColumns(db);
  ensureOrderMetaColumns(db);
  ensureSuppliersColumns(db);
  ensureSalesUniqueness(db);
  ensureSalesSnapshotColumns(db);
  ensurePriceHistory(db);
  ensureCompanyExpensesTable(db);
  ensureOrderLineMetaTable(db);
  ensureOrderItemsTable(db);
  ensureProductCatalogCacheTables(db);

  // Ensure a default wallet config row exists
  const existing = db.prepare("SELECT value FROM config WHERE key=?").get("walletConfig");
  if (!existing) {
    const defaultCfg = {
      baseUrl: "https://dashboard.toters-api.com",
      storeId: "",
      wallet: "main",
      token: "",
      usdToLbpRate: 90000,
      displayCurrency: "USD"
    };
    db.prepare(
      "INSERT INTO config(key, value) VALUES(?, ?)"
    ).run("walletConfig", JSON.stringify(defaultCfg));
  }

  return db;
}

function migrateLegacyDatabase(userDataPath, targetDbPath) {
  const parentDir = path.dirname(userDataPath);
  const legacyDirs = [
    path.join(parentDir, "Wallet Profit"),
    path.join(parentDir, "wallet-profit-app"),
    path.join(parentDir, "ANWallet"),
  ];
  const legacyFiles = ["wallet-profit.sqlite", "wallet_profit.sqlite"];

  let hasData = false;
  if (fs.existsSync(targetDbPath)) {
    try {
      const probe = new Database(targetDbPath, { readonly: true });
      const row = probe.prepare("SELECT COUNT(*) AS c FROM transactions").get();
      hasData = Number(row?.c || 0) > 0;
      probe.close();
    } catch {
      hasData = false;
    }
  }

  if (hasData) return { migrated: false };

  for (const legacyDir of legacyDirs) {
    if (legacyDir === userDataPath) continue;
    for (const file of legacyFiles) {
      const src = path.join(legacyDir, file);
      if (!fs.existsSync(src)) continue;
      try {
        const probe = new Database(src, { readonly: true });
        const row = probe.prepare("SELECT COUNT(*) AS c FROM transactions").get();
        probe.close();
        if (Number(row?.c || 0) === 0) continue;

        fs.copyFileSync(src, targetDbPath);
        return { migrated: true, from: src };
      } catch {
        // try next candidate
      }
    }
  }

  return { migrated: false };
}

function ensureSuppliersColumns(dbConn) {
  const cols = dbConn.prepare("PRAGMA table_info(suppliers)").all();
  const existing = new Set(cols.map((c) => c.name));

  if (!existing.has("color")) {
    dbConn.exec("ALTER TABLE suppliers ADD COLUMN color TEXT DEFAULT '#e8f4fc'");
  }
  if (!existing.has("phone")) {
    dbConn.exec("ALTER TABLE suppliers ADD COLUMN phone TEXT DEFAULT ''");
  }
  if (!existing.has("catalog_supplier_key")) {
    dbConn.exec("ALTER TABLE suppliers ADD COLUMN catalog_supplier_key TEXT");
  }
  dbConn.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_suppliers_catalog_supplier_key
    ON suppliers(catalog_supplier_key)
    WHERE catalog_supplier_key IS NOT NULL AND catalog_supplier_key != ''
  `);
}

function ensureOrderMetaColumns(dbConn) {
  const cols = dbConn.prepare("PRAGMA table_info(order_meta)").all();
  const existing = new Set(cols.map((c) => c.name));

  if (!existing.has("supplier_id")) {
    dbConn.exec("ALTER TABLE order_meta ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)");
  }
  if (!existing.has("has_adjusted_items")) {
    dbConn.exec("ALTER TABLE order_meta ADD COLUMN has_adjusted_items INTEGER DEFAULT 0");
  }
  if (!existing.has("adjusted_items_count")) {
    dbConn.exec("ALTER TABLE order_meta ADD COLUMN adjusted_items_count INTEGER DEFAULT 0");
  }
  if (!existing.has("cost_source")) {
    dbConn.exec("ALTER TABLE order_meta ADD COLUMN cost_source TEXT");
    dbConn.exec(`
      UPDATE order_meta SET cost_source='manual_override'
      WHERE cost_source IS NULL
        AND (supplier_cost > 0 OR supplier_paid = 1 OR supplier_id IS NOT NULL)
    `);
  }
}

function ensureProductsColumns(dbConn) {
  const cols = dbConn.prepare("PRAGMA table_info(products)").all();
  const existing = new Set(cols.map((c) => c.name));

  const additions = [
    ["store_name", "TEXT"],
    ["item_id", "INTEGER"],
    ["source_id", "INTEGER"],
    ["category_id", "INTEGER"],
    ["sub_category_id", "INTEGER"],
    ["alt_barcodes", "TEXT"],
    ["import_price_usd", "REAL"],
  ];

  for (const [name, type] of additions) {
    if (!existing.has(name)) {
      dbConn.exec(`ALTER TABLE products ADD COLUMN ${name} ${type}`);
    }
  }
}

function ensureSalesUniqueness(dbConn) {
  // Remove legacy duplicates so unique index creation can succeed.
  dbConn.exec(`
    DELETE FROM sales
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM sales
      GROUP BY order_code, barcode
    )
  `);

  dbConn.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sales_order_barcode
    ON sales(order_code, barcode)
    WHERE order_code IS NOT NULL AND barcode IS NOT NULL
  `);
}

function ensureCompanyExpensesTable(dbConn) {
  dbConn.exec(`
    CREATE TABLE IF NOT EXISTS company_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      description TEXT DEFAULT '',
      amount_lbp INTEGER NOT NULL DEFAULT 0,
      expense_date TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  dbConn.exec(`
    CREATE INDEX IF NOT EXISTS idx_company_expenses_date
    ON company_expenses(expense_date DESC)
  `);
}

function ensureOrderLineMetaTable(dbConn) {
  dbConn.exec(`
    CREATE TABLE IF NOT EXISTS order_line_meta (
      order_code TEXT NOT NULL,
      barcode TEXT NOT NULL,
      supplier_id INTEGER REFERENCES suppliers(id),
      supplier_cost_lbp INTEGER DEFAULT 0,
      supplier_paid INTEGER DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (order_code, barcode)
    )
  `);

  dbConn.exec(`
    CREATE INDEX IF NOT EXISTS idx_order_line_meta_supplier
    ON order_line_meta(supplier_id)
  `);

  const existing = new Set(
    dbConn.prepare("PRAGMA table_info(order_line_meta)").all().map((c) => c.name)
  );
  if (!existing.has("cost_source")) {
    dbConn.exec("ALTER TABLE order_line_meta ADD COLUMN cost_source TEXT");
  }
  if (!existing.has("merchant_code")) {
    dbConn.exec("ALTER TABLE order_line_meta ADD COLUMN merchant_code TEXT");
  }
}

function ensurePriceHistory(dbConn) {
  dbConn.exec(`
    CREATE TABLE IF NOT EXISTS product_price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      barcode TEXT,
      unit_price_usd REAL,
      cost_usd REAL,
      effective_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  dbConn.exec(`
    CREATE INDEX IF NOT EXISTS idx_price_history_product_effective
    ON product_price_history(product_id, effective_at DESC)
  `);

  // Backfill a baseline snapshot for products that have no history yet.
  dbConn.exec(`
    INSERT INTO product_price_history (product_id, barcode, unit_price_usd, cost_usd, effective_at)
    SELECT p.id, p.barcode, p.unit_price_usd, p.cost_usd, COALESCE(p.updated_at, p.created_at, CURRENT_TIMESTAMP)
    FROM products p
    WHERE NOT EXISTS (
      SELECT 1
      FROM product_price_history h
      WHERE h.product_id = p.id
    )
  `);
}

function ensureSalesSnapshotColumns(dbConn) {
  const existing = new Set(dbConn.prepare("PRAGMA table_info(sales)").all().map((c) => c.name));
  const additions = [
    ["catalog_product_id", "TEXT"],
    ["item_name_snapshot", "TEXT"],
    ["image_url_snapshot", "TEXT"],
    ["unit_supplier_cost_usd", "REAL"],
    ["total_supplier_cost_usd", "REAL"],
    ["supplier_id", "INTEGER REFERENCES suppliers(id)"],
    ["merchant_code", "TEXT"],
    ["catalog_sync_status", "TEXT"],
    ["cost_source", "TEXT"],
    ["cost_snapshot_at", "TEXT"],
  ];
  for (const [name, type] of additions) {
    if (!existing.has(name)) dbConn.exec(`ALTER TABLE sales ADD COLUMN ${name} ${type}`);
  }
}

function ensureOrderItemsTable(dbConn) {
  const existingColumns = dbConn.prepare("PRAGMA table_info(order_items)").all();
  if (existingColumns.length) {
    const names = new Set(existingColumns.map((column) => column.name));
    if (!names.has("order_code") || !names.has("line_key")) {
      let legacyName = "order_items_legacy";
      let suffix = 2;
      while (dbConn.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(legacyName)) {
        legacyName = `order_items_legacy_${suffix}`;
        suffix += 1;
      }
      dbConn.exec(`ALTER TABLE order_items RENAME TO ${legacyName}`);
      console.warn(`Preserved incompatible legacy order_items table as ${legacyName}`);
    }
  }
  dbConn.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT NOT NULL,
      line_key TEXT NOT NULL,
      barcode TEXT,
      item_name_snapshot TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      unit_selling_price_usd REAL,
      total_selling_price_usd REAL,
      catalog_product_id TEXT,
      image_url_snapshot TEXT,
      supplier_id INTEGER REFERENCES suppliers(id),
      supplier_key TEXT,
      merchant_code TEXT,
      unit_supplier_cost_usd REAL,
      total_supplier_cost_usd REAL,
      cost_source TEXT,
      catalog_sync_status TEXT NOT NULL DEFAULT 'pending',
      catalog_error TEXT,
      order_created_at TEXT,
      cost_snapshot_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(order_code, line_key)
    );
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_code);
    CREATE INDEX IF NOT EXISTS idx_order_items_barcode ON order_items(barcode);
    CREATE INDEX IF NOT EXISTS idx_order_items_catalog_status ON order_items(catalog_sync_status);
    CREATE INDEX IF NOT EXISTS idx_order_items_supplier ON order_items(supplier_id);
  `);
}

function ensureProductCatalogCacheTables(dbConn) {
  dbConn.exec(`
    CREATE TABLE IF NOT EXISTS product_catalog_cache (
      supabase_id TEXT PRIMARY KEY,
      barcode TEXT NOT NULL UNIQUE,
      item_name TEXT NOT NULL,
      sku TEXT,
      brand TEXT,
      category TEXT,
      sub_category TEXT,
      description TEXT,
      model_name TEXT,
      color TEXT,
      measurement_unit TEXT,
      measurement_value TEXT,
      selling_price_usd REAL,
      vendor_price_usd REAL,
      merchant_code TEXT,
      supplier_key TEXT,
      supplier_name TEXT,
      image_url TEXT,
      image_urls_json TEXT DEFAULT '[]',
      stock_quantity REAL,
      is_available INTEGER NOT NULL DEFAULT 1,
      is_archived INTEGER NOT NULL DEFAULT 0,
      stock_status TEXT NOT NULL DEFAULT 'in_stock',
      supabase_updated_at TEXT,
      cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_product_catalog_cache_name
      ON product_catalog_cache(item_name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_product_catalog_cache_merchant
      ON product_catalog_cache(merchant_code);
    CREATE INDEX IF NOT EXISTS idx_product_catalog_cache_supplier
      ON product_catalog_cache(supplier_key);

    CREATE TABLE IF NOT EXISTS catalog_merchant_supplier_cache (
      merchant_code TEXT PRIMARY KEY,
      supplier_key TEXT NOT NULL,
      supplier_name TEXT NOT NULL,
      supabase_updated_at TEXT,
      cached_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function closeDatabase() {
  if (!db) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  } catch {
    // ignore close errors during restore
  }
  db = null;
}

function replaceDatabaseFromFile(sourceFilePath) {
  if (!dbPath) {
    throw new Error("Database not initialized. Call initDatabase(userDataPath) first.");
  }

  const userDataPath = path.dirname(dbPath);
  const target = dbPath;

  closeDatabase();

  fs.copyFileSync(sourceFilePath, target);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.unlinkSync(target + suffix);
    } catch {
      // no wal/shm file
    }
  }

  initDatabase(userDataPath);
  return { ok: true };
}

function getDb() {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase(userDataPath) first.");
  }
  return db;
}

function getDbPath() {
  if (!dbPath) {
    throw new Error("Database not initialized. Call initDatabase(userDataPath) first.");
  }
  return dbPath;
}

module.exports = {
  initDatabase,
  closeDatabase,
  replaceDatabaseFromFile,
  getDb,
  getDbPath,
};

