const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

let db;
let dbPath;

function initDb(userDataPath) {
  dbPath = path.join(userDataPath, "wallet-profit.sqlite");
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
  `);

  // Default wallet config
  const existing = db.prepare("SELECT value FROM config WHERE key=?").get("walletConfig");
  if (!existing) {
    saveWalletConfig({
      baseUrl: "https://dashboard.toters-api.com",
      storeId: "100908",
      wallet: "main",
      token: ""
    });
  }
}

function extractOrderCode(reason) {
  if (!reason) return null;
  const m = String(reason).match(/order\s+(\d{3,}-\d{3,})/i);
  return m ? m[1] : null;
}

function normalizeType(type) {
  const t = (type || "").trim().toLowerCase();

  // API types
  if (t === "gross_app_revenue") return "gross";
  if (t === "store_listing_fee") return "service_fee";
  if (t === "value_added_tax") return "vat";
  if (t === "merchant_incentive") return "incentive";
  if (t === "balance_settlement") return "settlement";

  // Text exports
  if (t.includes("gross")) return "gross";
  if (t.includes("store listing") || t.includes("service fee")) return "service_fee";
  if (t.includes("value added") || t.includes("vat")) return "vat";
  if (t.includes("merchant incentive") || t.includes("cashback")) return "incentive";
  if (t.includes("balance settlement") || t.includes("settlement")) return "settlement";

  return "other";
}

function parseRows(text) {
  const lines = (text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [];

  for (const line of lines) {
    if (/^id\s+amount\s+reason/i.test(line) || /^id\tamount\treason/i.test(line)) continue;

    let parts = line.split("\t").map(s => s.trim());
    if (parts.length < 5) parts = line.split(/\s{2,}/).map(s => s.trim());
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

function importTransactionsText(text) {
  const rows = parseRows(text);

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
        order_code
      });
      if (info.changes === 1) inserted++;
      else ignored++;
    }

    return { inserted, ignored };
  });

  return insertMany(rows);
}

function upsertOrderMeta({ order_code, supplier_cost, supplier_paid }) {
  if (!order_code) return { ok: false, error: "Missing order_code" };

  db.prepare(`
    INSERT INTO order_meta(order_code, supplier_cost, supplier_paid, updated_at)
    VALUES(?, ?, ?, datetime('now'))
    ON CONFLICT(order_code) DO UPDATE SET
      supplier_cost=excluded.supplier_cost,
      supplier_paid=excluded.supplier_paid,
      updated_at=datetime('now')
  `).run(order_code, Math.trunc(supplier_cost || 0), supplier_paid ? 1 : 0);

  return { ok: true };
}

function resetSupplierMeta() {
  db.prepare("DELETE FROM order_meta").run();
  return { ok: true };
}

function computeOrders() {
  const rows = db.prepare(`
    SELECT id, amount, reason, type, created_at, order_code
    FROM transactions
    ORDER BY created_at ASC
  `).all();

  const byOrder = new Map();
  let settlementsTotal = 0;

  for (const r of rows) {
    const ntype = normalizeType(r.type);
    const amt = Number(r.amount) || 0;

    if (ntype === "settlement") {
      settlementsTotal += amt;
      continue;
    }

    const oc = r.order_code;
    if (!oc) continue;

    if (!byOrder.has(oc)) {
      byOrder.set(oc, {
        order_code: oc,
        gross: 0,
        service_fee: 0,
        vat: 0,
        incentive: 0,
        row_count: 0,
        dates: new Set()
      });
    }

    const agg = byOrder.get(oc);
    agg.row_count += 1;
    if (r.created_at) agg.dates.add(r.created_at);

    if (ntype === "gross") agg.gross += Math.abs(amt);
    else if (ntype === "service_fee") agg.service_fee += amt;
    else if (ntype === "vat") agg.vat += amt;
    else if (ntype === "incentive") agg.incentive += Math.abs(amt);
  }

  const metas = db.prepare("SELECT order_code, supplier_cost, supplier_paid FROM order_meta").all();
  const metaMap = new Map(metas.map(m => [m.order_code, m]));

  const orders = [];
  for (const agg of byOrder.values()) {
    const meta = metaMap.get(agg.order_code) || { supplier_cost: 0, supplier_paid: 0 };

const incentive = agg.incentive || 0;

const merchant_payout =
  (agg.gross || 0)
  - (agg.service_fee || 0)
  - (agg.vat || 0)
  + incentive;

const toters_profit =
  (agg.service_fee || 0)
  + (agg.vat || 0)
  - incentive;

const net_profit =
  merchant_payout - (meta.supplier_cost || 0);

    const toters_margin = (agg.vat || 0) + (agg.service_fee || 0) - (agg.incentive || 0);
    //const merchant_payout = (agg.gross || 0) - (agg.service_fee || 0) - (agg.vat || 0) - (agg.incentive || 0);
    //const net_profit = toters_margin - (meta.supplier_cost || 0);

    const datesArr = Array.from(agg.dates);
    orders.push({
      order_code: agg.order_code,
      gross: agg.gross,
      service_fee: agg.service_fee,
      vat: agg.vat,
      incentive: agg.incentive,
      merchant_payout,
      toters_margin,
      supplier_cost: meta.supplier_cost || 0,
      supplier_paid: meta.supplier_paid ? 1 : 0,
      net_profit,
      row_count: agg.row_count,
      dates: datesArr.slice(0, 6).join(" | ") + (datesArr.length > 6 ? " ..." : "")
    });
  }

  orders.sort((a, b) => a.order_code.localeCompare(b.order_code));
  return { orders, settlementsTotal };
}

function getOrdersReconciliation(opts = {}) {
  const { orders } = computeOrders();
  return orders;
}

function getTotals(opts = {}) {
  const includeSettlements = !!opts.includeSettlements;

  const { orders, settlementsTotal } = computeOrders();

  const totals = {
    orders: orders.length,
    gross: 0,
    service_fee: 0,
    vat: 0,
    incentive: 0,
    merchantPayout: 0,
    totersMargin: 0,
    supplierCost: 0,
    netProfit: 0,
    settlements: settlementsTotal,
    netProfitWithSettlements: includeSettlements ? 0 : null
  };

  for (const o of orders) {
    totals.gross += o.gross || 0;
    totals.service_fee += o.service_fee || 0;
    totals.vat += o.vat || 0;
    totals.incentive += o.incentive || 0;
    totals.merchantPayout += o.merchant_payout || 0;
    totals.totersMargin += o.toters_margin || 0;
    totals.supplierCost += o.supplier_cost || 0;
    totals.netProfit += o.net_profit || 0;
  }

  if (includeSettlements) totals.netProfitWithSettlements = totals.netProfit + settlementsTotal;
  return totals;
}

function exportOrdersCsv() {
  const { orders } = computeOrders();
  const header = [
    "order_code","gross","service_fee","vat","incentive","merchant_payout","toters_margin",
    "supplier_cost","supplier_paid","net_profit","row_count","dates"
  ];

  const lines = [header.join(",")];
  for (const o of orders) {
    const row = [
      o.order_code,
      o.gross,
      o.service_fee,
      o.vat,
      o.incentive,
      o.merchant_payout,
      o.toters_margin,
      o.supplier_cost,
      o.supplier_paid,
      o.net_profit,
      o.row_count,
      JSON.stringify(o.dates || "")
    ];
    lines.push(row.join(","));
  }

  const outPath = path.join(path.dirname(dbPath), "orders-reconciliation.csv");
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  return outPath;
}

function exportBackupJson() {
  const tx = db.prepare("SELECT * FROM transactions ORDER BY id ASC").all();
  const meta = db.prepare("SELECT * FROM order_meta ORDER BY order_code ASC").all();
  const cfg = getWalletConfig();

  const out = {
    exported_at: new Date().toISOString(),
    transactions: tx,
    order_meta: meta,
    walletConfig: cfg
  };

  const outPath = path.join(path.dirname(dbPath), "wallet-profit-backup.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  return outPath;
}

function importBackupJsonFromFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);

  const tx = Array.isArray(data.transactions) ? data.transactions : [];
  const meta = Array.isArray(data.order_meta) ? data.order_meta : [];
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
        order_code: r.order_code || extractOrderCode(r.reason)
      });
    }

    for (const m of meta) {
      insertMeta.run({
        order_code: m.order_code,
        supplier_cost: Math.trunc(m.supplier_cost || 0),
        supplier_paid: m.supplier_paid ? 1 : 0
      });
    }

    if (walletConfig && typeof walletConfig === "object") saveWalletConfig(walletConfig);
  });

  txn();
  return { ok: true, imported_transactions: tx.length, imported_meta: meta.length };
}

function getWalletConfig() {
  const row = db.prepare("SELECT value FROM config WHERE key=?").get("walletConfig");
  try {
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

function saveWalletConfig(cfg) {
  const safe = {
    baseUrl: String(cfg.baseUrl || "https://dashboard.toters-api.com").trim(),
    storeId: String(cfg.storeId || "").trim(),
    wallet: String(cfg.wallet || "main").trim() || "main",
    token: String(cfg.token || "").trim()
  };

  db.prepare(
    "INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run("walletConfig", JSON.stringify(safe));

  return { ok: true };
}

async function syncWallet() {
  const cfg = getWalletConfig();
  if (!cfg?.baseUrl || !cfg?.storeId || !cfg?.token) {
    return { ok: false, error: "Missing config: baseUrl/storeId/token (open Wallet Settings)" };
  }

  let nextUrl = `${cfg.baseUrl}/api/stores/${cfg.storeId}/wallet/all?page=1&wallet=${encodeURIComponent(cfg.wallet || "main")}`;
  let totalFetched = 0;
  let totalInserted = 0;
  let totalIgnored = 0;
  let pages = 0;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO transactions(id, store_id, amount, wallet, reason, type, created_at, order_code)
    VALUES(@id, @store_id, @amount, @wallet, @reason, @type, @created_at, @order_code)
  `);

  const insertMany = db.transaction((items) => {
    let inserted = 0, ignored = 0;
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
        order_code
      });
      if (info.changes === 1) inserted++; else ignored++;
    }
    console.log("SYNC URL =", nextUrl);
    return { inserted, ignored };
  });

  while (nextUrl) {
    pages += 1;

    const resp = await fetch(nextUrl, {
      headers: {
        "Authorization": `Bearer ${cfg.token}`,
        "Accept": "application/json"
      }
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
    nextUrl = wallet?.next_page_url + '&wallet=${encodeURIComponent(cfg.wallet || "main")}' || null;
    console.log("NEXT URL =", nextUrl);
    // safety
    if (pages > 500) break;
  }

  return { ok: true, pages, totalFetched, totalInserted, totalIgnored };
}

module.exports = {
  initDb,
  importTransactionsText,
  getOrdersReconciliation,
  getTotals,
  upsertOrderMeta,
  resetSupplierMeta,
  exportOrdersCsv,
  exportBackupJson,
  importBackupJsonFromFile,
  getWalletConfig,
  saveWalletConfig,
  syncWallet
};

function withWallet(urlStr, wallet) {
  const w = (wallet || "").trim();
  if (!w) throw new Error("Wallet is empty. Please set it in Wallet Settings.");

  const u = new URL(urlStr);
  u.searchParams.set("wallet", w);
  return u.toString();
}
