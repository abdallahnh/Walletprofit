const fs = require("fs");
const path = require("path");
const { getDb, getDbPath } = require("./database");

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

  if (t.includes("gross")) return "gross";
  if (t.includes("store listing") || t.includes("service fee")) return "service_fee";
  if (t.includes("value added") || t.includes("vat")) return "vat";
  if (t.includes("merchant incentive") || t.includes("cashback")) return "incentive";
  if (t.includes("balance settlement") || t.includes("settlement")) return "settlement";

  return "other";
}

function parseWalletTsv(text) {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows = [];

  for (const line of lines) {
    if (/^id\s+amount\s+reason/i.test(line) || /^id\tamount\treason/i.test(line)) continue;

    let parts = line.split("\t").map((s) => s.trim());
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

function exportBackupJson() {
  const db = getDb();
  const dbPath = getDbPath();

  const tx = db.prepare("SELECT * FROM transactions ORDER BY id ASC").all();
  const meta = db.prepare("SELECT * FROM order_meta ORDER BY order_code ASC").all();
  const products = db.prepare("SELECT * FROM products ORDER BY id ASC").all();
  const sales = db.prepare("SELECT * FROM sales ORDER BY id ASC").all();
  const cfg = getWalletConfig();

  const out = {
    exported_at: new Date().toISOString(),
    transactions: tx,
    order_meta: meta,
    walletConfig: cfg,
    products,
    sales,
  };

  const outPath = path.join(path.dirname(dbPath), "wallet-profit-backup.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  return outPath;
}

function importBackupJsonFromFile(filePath) {
  const db = getDb();
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);

  const tx = Array.isArray(data.transactions) ? data.transactions : [];
  const meta = Array.isArray(data.order_meta) ? data.order_meta : [];
  const products = Array.isArray(data.products) ? data.products : [];
  const sales = Array.isArray(data.sales) ? data.sales : [];
  const walletConfig = data.walletConfig || null;

  const insertTx = db.prepare(`
    INSERT OR IGNORE INTO transactions(id, store_id, amount, wallet, reason, type, created_at, order_code)
    VALUES(@id, @store_id, @amount, @wallet, @reason, @type, @created_at, @order_code)
  `);

  const insertMeta = db.prepare(`
    INSERT INTO order_meta(order_code, supplier_cost, supplier_paid, updated_at)
    VALUES(@order_code, @supplier_cost, @supplier_paid, datetime('now'))
    ON CONFLICT(order_code) DO UPDATE SET
      supplier_cost=excluded.supplier_cost,
      supplier_paid=excluded.supplier_paid,
      updated_at=datetime('now')
  `);

  const insertProduct = db.prepare(`
    INSERT INTO products (
      id,
      barcode,
      item_name,
      sku,
      brand,
      category,
      sub_category,
      unit_price_usd,
      cost_usd,
      measurement_unit,
      measurement_value,
      description,
      image_url,
      stock_quantity,
      created_at,
      updated_at
    )
    VALUES (
      @id,
      @barcode,
      @item_name,
      @sku,
      @brand,
      @category,
      @sub_category,
      @unit_price_usd,
      @cost_usd,
      @measurement_unit,
      @measurement_value,
      @description,
      @image_url,
      @stock_quantity,
      @created_at,
      @updated_at
    )
    ON CONFLICT(barcode) DO UPDATE SET
      item_name = excluded.item_name,
      sku = excluded.sku,
      brand = excluded.brand,
      category = excluded.category,
      sub_category = excluded.sub_category,
      unit_price_usd = excluded.unit_price_usd,
      cost_usd = excluded.cost_usd,
      measurement_unit = excluded.measurement_unit,
      measurement_value = excluded.measurement_value,
      description = excluded.description,
      image_url = excluded.image_url,
      stock_quantity = excluded.stock_quantity,
      updated_at = excluded.updated_at
  `);

  const insertSale = db.prepare(`
    INSERT INTO sales (
      id,
      order_code,
      barcode,
      product_id,
      quantity,
      unit_price,
      cost,
      total_sale,
      profit,
      created_at
    )
    VALUES (
      @id,
      @order_code,
      @barcode,
      @product_id,
      @quantity,
      @unit_price,
      @cost,
      @total_sale,
      @profit,
      @created_at
    )
    ON CONFLICT(id) DO NOTHING
  `);

  const txn = db.transaction(() => {
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
      });
    }

    for (const p of products) {
      insertProduct.run({
        id: p.id,
        barcode: p.barcode,
        item_name: p.item_name,
        sku: p.sku,
        brand: p.brand,
        category: p.category,
        sub_category: p.sub_category,
        unit_price_usd: p.unit_price_usd,
        cost_usd: p.cost_usd,
        measurement_unit: p.measurement_unit,
        measurement_value: p.measurement_value,
        description: p.description,
        image_url: p.image_url,
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

    if (walletConfig && typeof walletConfig === "object") saveWalletConfig(walletConfig);
  });

  txn();
  return {
    ok: true,
    imported_transactions: tx.length,
    imported_meta: meta.length,
    imported_products: products.length,
    imported_sales: sales.length,
  };
}

module.exports = {
  importWalletTsv,
  getWalletConfig,
  saveWalletConfig,
  syncWallet,
  exportBackupJson,
  importBackupJsonFromFile,
  extractOrderCode,
  normalizeType,
};

