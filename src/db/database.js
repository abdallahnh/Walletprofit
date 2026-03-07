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

    CREATE TABLE IF NOT EXISTS order_meta (
      order_code TEXT PRIMARY KEY,
      supplier_cost INTEGER DEFAULT 0,
      supplier_paid INTEGER DEFAULT 0,
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
      category TEXT,
      sub_category TEXT,
      unit_price_usd REAL,
      cost_usd REAL,
      measurement_unit TEXT,
      measurement_value TEXT,
      description TEXT,
      image_url TEXT,
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
  `);

  // Ensure a default wallet config row exists
  const existing = db.prepare("SELECT value FROM config WHERE key=?").get("walletConfig");
  if (!existing) {
    const defaultCfg = {
      baseUrl: "https://dashboard.toters-api.com",
      storeId: "",
      wallet: "main",
      token: ""
    };
    db.prepare(
      "INSERT INTO config(key, value) VALUES(?, ?)"
    ).run("walletConfig", JSON.stringify(defaultCfg));
  }

  return db;
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
  getDb,
  getDbPath,
};

