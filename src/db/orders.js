const path = require("path");
const fs = require("fs");
const { getDb, getDbPath } = require("./database");
const { normalizeType } = require("./wallet");
const { getOrCreateSupplier } = require("./suppliers");

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
        types: new Set(),
      });
    }

    const agg = byOrder.get(oc);
    agg.types.add(ntype);

    agg.row_count += 1;
    if (r.created_at) agg.dates.add(r.created_at);

    if (ntype === "gross") agg.gross += Math.abs(amt);
    else if (ntype === "service_fee") agg.service_fee += amt;
    else if (ntype === "vat") agg.vat += amt;
    else if (ntype === "incentive") agg.incentive += Math.abs(amt);
  }

  const metas = db
    .prepare(
      `
    SELECT om.order_code, om.supplier_cost, om.supplier_paid, om.supplier_id, s.name AS supplier_name
    FROM order_meta om
    LEFT JOIN suppliers s ON s.id = om.supplier_id
  `
    )
    .all();
  const metaMap = new Map(metas.map((m) => [m.order_code, m]));

  const orders = [];
  for (const agg of byOrder.values()) {
    const meta = metaMap.get(agg.order_code) || {
      supplier_cost: 0,
      supplier_paid: 0,
      supplier_id: null,
      supplier_name: "",
    };

    const incentive = agg.incentive || 0;

    const merchant_payout = agg.gross - agg.service_fee - agg.vat + incentive;

    const toters_margin = agg.service_fee + agg.vat - incentive;

    const net_profit = merchant_payout - (meta.supplier_cost || 0);

    const datesArr = Array.from(agg.dates).sort();
    const primary_date = datesArr[0] || "";
    const typeList = Array.from(agg.types).filter((t) => t !== "other");
    const expectedTypes = ["gross", "service_fee", "vat"];
    const missingTypes = expectedTypes.filter((t) => !agg.types.has(t));
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
      supplier_id: meta.supplier_id || null,
      supplier_name: meta.supplier_name || "",
      net_profit,
      row_count: agg.row_count,
      primary_date,
      dates: datesArr.slice(0, 6).join(" | ") + (datesArr.length > 6 ? " ..." : ""),
      transaction_types: typeList.join(","),
      missing_types: missingTypes.join(","),
      has_missing_types: missingTypes.length > 0 ? 1 : 0,
    });
  }

  orders.sort((a, b) => a.order_code.localeCompare(b.order_code));

  return { orders, settlementsTotal };
}

function getOrdersReconciliation() {
  const { orders } = computeOrders();
  return orders;
}

function getSupplierSummary(opts = {}) {
  const supplierIds = Array.isArray(opts.supplierIds)
    ? opts.supplierIds.map(Number).filter((id) => id > 0)
    : null;
  const { from, to } = opts;

  const { orders } = computeOrders();

  const bySupplier = new Map();

  for (const o of orders) {
    if (from && o.primary_date && o.primary_date < from) continue;
    if (to && o.primary_date && o.primary_date > to) continue;

    if (supplierIds && supplierIds.length > 0) {
      if (!o.supplier_id || !supplierIds.includes(o.supplier_id)) continue;
    }

    const key = o.supplier_id || 0;
    const name = o.supplier_name || "(Unassigned)";

    if (!bySupplier.has(key)) {
      bySupplier.set(key, {
        supplier_id: o.supplier_id || null,
        supplier_name: name,
        orders: 0,
        revenue: 0,
        supplier_cost: 0,
        payable: 0,
        profit: 0,
      });
    }

    const row = bySupplier.get(key);
    row.orders += 1;
    row.revenue += o.merchant_payout || 0;
    row.supplier_cost += o.supplier_cost || 0;
    if (!o.supplier_paid) {
      row.payable += o.supplier_cost || 0;
    }
    row.profit += o.net_profit || 0;
  }

  return Array.from(bySupplier.values()).sort((a, b) =>
    a.supplier_name.localeCompare(b.supplier_name)
  );
}

function getTotals(opts = {}) {
  const includeSettlements = !!opts.includeSettlements;
  const supplierIds = Array.isArray(opts.supplierIds)
    ? opts.supplierIds.map(Number).filter((id) => id > 0)
    : null;

  const { orders, settlementsTotal } = computeOrders();

  const totals = {
    orders: 0,
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
    if (supplierIds && supplierIds.length > 0) {
      if (!o.supplier_id || !supplierIds.includes(o.supplier_id)) continue;
    }

    totals.orders += 1;
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

function upsertOrderMeta({ order_code, supplier_cost, supplier_paid, supplier_name, supplier_id }) {
  if (!order_code) return { ok: false, error: "Missing order_code" };

  const cost = Math.trunc(supplier_cost || 0);
  const paid = supplier_paid ? 1 : 0;

  let resolvedSupplierId = null;

  if (supplier_name !== undefined && supplier_name !== null) {
    const trimmed = String(supplier_name).trim();
    if (trimmed) {
      const supplier = getOrCreateSupplier(trimmed);
      resolvedSupplierId = supplier?.id || null;
    }
  } else if (supplier_id !== undefined) {
    resolvedSupplierId = supplier_id ? Number(supplier_id) || null : null;
  }

  if ((cost > 0 || paid) && !resolvedSupplierId) {
    return { ok: false, error: "Supplier name is required when setting cost or paid status" };
  }

  const db = getDb();

  db.prepare(
    `
    INSERT INTO order_meta(order_code, supplier_cost, supplier_paid, supplier_id, updated_at)
    VALUES(?, ?, ?, ?, datetime('now'))
    ON CONFLICT(order_code) DO UPDATE SET
      supplier_cost=excluded.supplier_cost,
      supplier_paid=excluded.supplier_paid,
      supplier_id=excluded.supplier_id,
      updated_at=datetime('now')
  `
  ).run(order_code, cost, paid, resolvedSupplierId);

  return { ok: true, supplier_id: resolvedSupplierId };
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
    "supplier_name",
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
      JSON.stringify(o.supplier_name || ""),
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
  getSupplierSummary,
  getTotals,
  upsertOrderMeta,
  resetSupplierMeta,
  exportOrdersCsv,
};
