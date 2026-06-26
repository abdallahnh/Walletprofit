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
  ensureSalesUniqueness(db);
  ensurePriceHistory(db);

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

function ensureOrderMetaColumns(dbConn) {
  const cols = dbConn.prepare("PRAGMA table_info(order_meta)").all();
  const existing = new Set(cols.map((c) => c.name));

  if (!existing.has("supplier_id")) {
    dbConn.exec("ALTER TABLE order_meta ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)");
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

