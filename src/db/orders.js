const path = require("path");
const fs = require("fs");
const { getDb, getDbPath } = require("./database");
const { normalizeType } = require("./wallet");

function computeOrders() {
  const db = getDb();

  const rows = db
    .prepare(
      `
    SELECT id, amount, reason, type, created_at, order_code
    FROM transactions
    ORDER BY created_at ASC
  `
    )
    .all();

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
        dates: new Set(),
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
  const metaMap = new Map(metas.map((m) => [m.order_code, m]));

  const orders = [];
  for (const agg of byOrder.values()) {
    const meta = metaMap.get(agg.order_code) || { supplier_cost: 0, supplier_paid: 0 };

    const incentive = agg.incentive || 0;

    const merchant_payout = agg.gross - agg.service_fee - agg.vat + incentive;

    const toters_margin = agg.service_fee + agg.vat - incentive;

    const net_profit = merchant_payout - (meta.supplier_cost || 0);

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
      dates: datesArr.slice(0, 6).join(" | ") + (datesArr.length > 6 ? " ..." : ""),
    });
  }

  orders.sort((a, b) => a.order_code.localeCompare(b.order_code));

  return { orders, settlementsTotal };
}

function getOrdersReconciliation() {
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
    netProfitWithSettlements: includeSettlements ? 0 : null,
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

function upsertOrderMeta({ order_code, supplier_cost, supplier_paid }) {
  if (!order_code) return { ok: false, error: "Missing order_code" };
  const db = getDb();

  db.prepare(
    `
    INSERT INTO order_meta(order_code, supplier_cost, supplier_paid, updated_at)
    VALUES(?, ?, ?, datetime('now'))
    ON CONFLICT(order_code) DO UPDATE SET
      supplier_cost=excluded.supplier_cost,
      supplier_paid=excluded.supplier_paid,
      updated_at=datetime('now')
  `
  ).run(order_code, Math.trunc(supplier_cost || 0), supplier_paid ? 1 : 0);

  return { ok: true };
}

function resetSupplierMeta() {
  const db = getDb();
  db.prepare("DELETE FROM order_meta").run();
  return { ok: true };
}

function exportOrdersCsv() {
  const { orders } = computeOrders();
  const dbPath = getDbPath();

  const header = [
    "order_code",
    "gross",
    "service_fee",
    "vat",
    "incentive",
    "merchant_payout",
    "toters_margin",
    "supplier_cost",
    "supplier_paid",
    "net_profit",
    "row_count",
    "dates",
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
      JSON.stringify(o.dates || ""),
    ];
    lines.push(row.join(","));
  }

  const outPath = path.join(path.dirname(dbPath), "orders-reconciliation.csv");
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  return outPath;
}

module.exports = {
  computeOrders,
  getOrdersReconciliation,
  getTotals,
  upsertOrderMeta,
  resetSupplierMeta,
  exportOrdersCsv,
};

