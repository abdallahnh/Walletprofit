const path = require("path");
const fs = require("fs");
const { getDb, getDbPath } = require("./database");
const { getWalletConfig, normalizeType, grossAmountToMerchant } = require("./wallet");
const { getOrCreateSupplier } = require("./suppliers");
const { normalizeOrderDetailItems } = require("../services/orderDetailItems");
const {
  getOrderLineTotals,
  getLineMetaForOrder,
  upsertLineMeta,
  clearLineMetaForOrder,
  getItemCountsByOrder,
  getSalesItemCount,
  ensureLineMetaFromSales,
  getOrderItemsMap,
} = require("./orderLineMeta");

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
        marketing: 0,
        row_count: 0,
        dates: new Set(),
        types: new Set(),
      });
    }

    const agg = byOrder.get(oc);
    agg.types.add(ntype);

    agg.row_count += 1;
    if (r.created_at) agg.dates.add(r.created_at);

    if (ntype === "gross") agg.gross += grossAmountToMerchant(amt);
    else if (ntype === "service_fee") agg.service_fee += amt;
    else if (ntype === "vat") agg.vat += amt;
    else if (ntype === "incentive") agg.incentive += Math.abs(amt);
    else if (ntype === "marketing") agg.marketing += Math.abs(amt);
  }

  const metas = db
    .prepare(
      `
    SELECT om.order_code, om.supplier_cost, om.supplier_paid, om.supplier_id,
           om.has_adjusted_items, om.adjusted_items_count,
           s.name AS supplier_name, s.color AS supplier_color, s.phone AS supplier_phone
    FROM order_meta om
    LEFT JOIN suppliers s ON s.id = om.supplier_id
  `
    )
    .all();
  const metaMap = new Map(metas.map((m) => [m.order_code, m]));
  const multiItemOrders = getItemCountsByOrder();
  const orderItemsMap = getOrderItemsMap(db);

  const orders = [];
  for (const agg of byOrder.values()) {
    const meta = metaMap.get(agg.order_code) || {
      supplier_cost: 0,
      supplier_paid: 0,
      supplier_id: null,
      supplier_name: "",
      supplier_color: "",
      supplier_phone: "",
      has_adjusted_items: 0,
      adjusted_items_count: 0,
    };

    const itemCount = multiItemOrders.get(agg.order_code) || getSalesItemCount(db, agg.order_code) || 1;
    if (itemCount > 1) {
      ensureLineMetaFromSales(agg.order_code);
    }

    const lineTotals = getOrderLineTotals(agg.order_code);
    if (lineTotals.has_lines) {
      const salesRows = db
        .prepare(
          `
        SELECT barcode, total_sale
        FROM sales
        WHERE order_code = ?
      `
        )
        .all(agg.order_code);
      const salesByBarcode = new Map(
        salesRows.map((s) => [s.barcode, Number(s.total_sale || 0)])
      );

      meta.supplier_cost = lineTotals.supplier_cost;
      meta.supplier_paid = lineTotals.supplier_paid;
      meta.supplier_id = lineTotals.supplier_id;
      meta.supplier_name = lineTotals.supplier_name;
      meta.supplier_line_ids = lineTotals.supplier_line_ids;
      meta.is_multi_supplier = lineTotals.is_multi_supplier;
      meta.line_meta = lineTotals.lines.map((l) => ({
        ...l,
        total_sale: salesByBarcode.get(l.barcode) || 0,
      }));
    }

    const orderItems = orderItemsMap.get(agg.order_code) || [];

    const incentive = agg.incentive || 0;
    const marketing = agg.marketing || 0;

    const merchant_payout = agg.gross - agg.service_fee - agg.vat + incentive - marketing;

    const toters_margin = agg.service_fee + agg.vat - incentive;

    const net_profit = merchant_payout - (meta.supplier_cost || 0);

    const datesArr = Array.from(agg.dates).sort();
    const primary_date = datesArr[0] || "";
    const latest_date = datesArr[datesArr.length - 1] || primary_date;
    const typeList = Array.from(agg.types).filter((t) => t !== "other");
    const expectedTypes = ["gross", "service_fee", "vat"];
    const missingTypes = expectedTypes.filter((t) => !agg.types.has(t));
    orders.push({
      order_code: agg.order_code,
      gross: agg.gross,
      service_fee: agg.service_fee,
      vat: agg.vat,
      incentive: agg.incentive,
      marketing,
      merchant_payout,
      toters_margin,
      supplier_cost: meta.supplier_cost || 0,
      supplier_paid: meta.supplier_paid ? 1 : 0,
      supplier_id: meta.supplier_id || null,
      supplier_name: meta.supplier_name || "",
      supplier_color: meta.supplier_color || "",
      supplier_phone: meta.supplier_phone || "",
      net_profit,
      row_count: agg.row_count,
      primary_date,
      latest_date,
      dates: datesArr.slice(0, 6).join(" | ") + (datesArr.length > 6 ? " ..." : ""),
      transaction_types: typeList.join(","),
      missing_types: missingTypes.join(","),
      has_missing_types: missingTypes.length > 0 ? 1 : 0,
      has_adjusted_items: meta.has_adjusted_items ? 1 : 0,
      adjusted_items_count: Number(meta.adjusted_items_count || 0),
      item_count: itemCount,
      is_splittable: itemCount > 1,
      is_multi_supplier: !!meta.is_multi_supplier,
      supplier_line_ids: meta.supplier_line_ids || (meta.supplier_id ? [meta.supplier_id] : []),
      line_meta: meta.line_meta || [],
      order_items: orderItems,
    });
  }

  orders.sort((a, b) => {
    const dateCmp = String(b.latest_date || b.primary_date || "").localeCompare(
      String(a.latest_date || a.primary_date || "")
    );
    if (dateCmp !== 0) return dateCmp;
    return String(b.order_code || "").localeCompare(String(a.order_code || ""));
  });

  return { orders, settlementsTotal };
}

function getOrdersReconciliation() {
  const { orders } = computeOrders();
  return orders;
}

function orderDateStr(o) {
  return String(o.latest_date || o.primary_date || "").slice(0, 10);
}

function filterWalletOrders(orders, opts = {}) {
  const { from, to, supplierIds } = opts;
  const ids = Array.isArray(supplierIds)
    ? supplierIds.map(Number).filter((id) => id > 0)
    : null;

  return orders.filter((o) => {
    const d = orderDateStr(o);
    if (from && d && d < from) return false;
    if (to && d && d > to) return false;
    if (ids?.length) {
      const lineIds = o.supplier_line_ids || [];
      const matches =
        (o.supplier_id && ids.includes(o.supplier_id)) ||
        lineIds.some((id) => ids.includes(id));
      if (!matches) return false;
    }
    return true;
  });
}

function periodKeyFromDate(dateStr, period) {
  if (!dateStr) return null;
  if (period === "month") return dateStr.slice(0, 7);
  if (period === "week") {
    const d = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(d.getTime())) return dateStr;
    const year = d.getFullYear();
    const start = new Date(year, 0, 1);
    const week = Math.floor((d - start) / 604800000);
    return `${year}-${String(week).padStart(2, "0")}`;
  }
  return dateStr;
}

function getWalletRevenueByPeriod(opts = {}) {
  const { period = "day" } = opts;
  const { orders } = computeOrders();
  const filtered = filterWalletOrders(orders, opts);
  const byPeriod = new Map();

  for (const o of filtered) {
    const key = periodKeyFromDate(orderDateStr(o), period);
    if (!key) continue;

    if (!byPeriod.has(key)) {
      byPeriod.set(key, {
        period: key,
        revenue: 0,
        cost: 0,
        profit: 0,
        quantity_sold: 0,
        order_count: 0,
      });
    }

    const row = byPeriod.get(key);
    row.revenue += o.merchant_payout || 0;
    row.cost += o.supplier_cost || 0;
    row.profit += o.net_profit || 0;
    row.order_count += 1;
    row.quantity_sold += o.row_count || 0;
  }

  return Array.from(byPeriod.values()).sort((a, b) => a.period.localeCompare(b.period));
}

function getSupplierSummary(opts = {}) {
  const supplierIds = Array.isArray(opts.supplierIds)
    ? opts.supplierIds.map(Number).filter((id) => id > 0)
    : null;
  const { from, to } = opts;

  const { orders } = computeOrders();
  const filtered = filterWalletOrders(orders, { from, to, supplierIds });

  const bySupplier = new Map();

  for (const o of filtered) {
    if (o.is_splittable && Array.isArray(o.line_meta) && o.line_meta.length > 0) {
      const salesTotal =
        o.line_meta.reduce((sum, l) => sum + Number(l.total_sale || 0), 0) ||
        o.line_meta.length;

      for (const line of o.line_meta) {
        const key = line.supplier_id || 0;
        const name = line.supplier_name || "(Unassigned)";
        if (supplierIds?.length && key && !supplierIds.includes(key)) continue;
        if (supplierIds?.length && !key) continue;

        if (!bySupplier.has(key)) {
          bySupplier.set(key, {
            supplier_id: line.supplier_id || null,
            supplier_name: name,
            orders: 0,
            revenue: 0,
            supplier_cost: 0,
            payable: 0,
            profit: 0,
          });
        }

        const share =
          salesTotal > 0
            ? Number(line.total_sale || 0) / salesTotal
            : 1 / o.line_meta.length;
        const row = bySupplier.get(key);
        row.orders += share;
        row.revenue += Math.round((o.merchant_payout || 0) * share);
        row.supplier_cost += Number(line.supplier_cost_lbp || 0);
        if (!line.supplier_paid) row.payable += Number(line.supplier_cost_lbp || 0);
        row.profit += Math.round((o.merchant_payout || 0) * share) - Number(line.supplier_cost_lbp || 0);
      }
      continue;
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
    marketing: 0,
    merchantPayout: 0,
    totersMargin: 0,
    supplierCost: 0,
    netProfit: 0,
    settlements: settlementsTotal,
    netProfitWithSettlements: includeSettlements ? 0 : null,
  };

  for (const o of orders) {
    if (supplierIds && supplierIds.length > 0) {
      const lineIds = o.supplier_line_ids || [];
      const matches =
        (o.supplier_id && supplierIds.includes(o.supplier_id)) ||
        lineIds.some((id) => supplierIds.includes(id));
      if (!matches) continue;
    }

    totals.orders += 1;
    totals.gross += o.gross || 0;
    totals.service_fee += o.service_fee || 0;
    totals.vat += o.vat || 0;
    totals.incentive += o.incentive || 0;
    totals.marketing += o.marketing || 0;
    totals.merchantPayout += o.merchant_payout || 0;
    totals.totersMargin += o.toters_margin || 0;
    totals.supplierCost += o.supplier_cost || 0;
    totals.netProfit += o.net_profit || 0;
  }

  if (includeSettlements) totals.netProfitWithSettlements = totals.netProfit + settlementsTotal;
  return totals;
}

function upsertOrderMeta({
  order_code,
  supplier_cost,
  supplier_paid,
  supplier_name,
  supplier_id,
  requireSupplier = true,
}) {
  if (!order_code) return { ok: false, error: "Missing order_code" };

  const db = getDb();
  const itemCount = getSalesItemCount(db, order_code);
  if (itemCount > 1) {
    return {
      ok: false,
      error: "This order has multiple items — click Lines and assign supplier + cost per item.",
    };
  }
  clearLineMetaForOrder(order_code);

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

  if (requireSupplier && (cost > 0 || paid) && !resolvedSupplierId) {
    return { ok: false, error: "Supplier name is required when setting cost or paid status" };
  }

  db.prepare(
    `
    INSERT INTO order_meta(order_code, supplier_cost, supplier_paid, supplier_id, cost_source, updated_at)
    VALUES(?, ?, ?, ?, 'manual_override', datetime('now'))
    ON CONFLICT(order_code) DO UPDATE SET
      supplier_cost=excluded.supplier_cost,
      supplier_paid=excluded.supplier_paid,
      supplier_id=excluded.supplier_id,
      cost_source='manual_override',
      updated_at=datetime('now')
  `
  ).run(order_code, cost, paid, resolvedSupplierId);

  return { ok: true, supplier_id: resolvedSupplierId };
}

function setOrderAdjustedFlag(orderCode, adjustedCount) {
  if (!orderCode) return { ok: false, error: "Missing order_code" };

  const count = Math.max(0, Number(adjustedCount) || 0);
  const hasAdjusted = count > 0 ? 1 : 0;
  const db = getDb();

  db.prepare(
    `
    INSERT INTO order_meta(order_code, has_adjusted_items, adjusted_items_count, updated_at)
    VALUES(?, ?, ?, datetime('now'))
    ON CONFLICT(order_code) DO UPDATE SET
      has_adjusted_items=excluded.has_adjusted_items,
      adjusted_items_count=excluded.adjusted_items_count,
      updated_at=datetime('now')
  `
  ).run(orderCode, hasAdjusted, count);

  return { ok: true, has_adjusted_items: hasAdjusted, adjusted_items_count: count };
}

function resetSupplierMeta() {
  const db = getDb();
  db.prepare("DELETE FROM order_line_meta").run();
  db.prepare("DELETE FROM order_meta").run();
  return { ok: true };
}

function exportOrdersCsv(destPath) {
  const { orders } = computeOrders();
  const dbPath = getDbPath();

  const header = [
    "order_code",
    "supplier_name",
    "gross",
    "service_fee",
    "vat",
    "incentive",
    "marketing",
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
      o.marketing,
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

  const outPath =
    destPath || path.join(path.dirname(dbPath), "orders-reconciliation.csv");
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  return outPath;
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

function importOrdersCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return { ok: false, error: "CSV file is empty or has no data rows" };
  }

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (name) => header.indexOf(name);

  const orderCodeIdx = idx("order_code");
  const supplierNameIdx = idx("supplier_name");
  const supplierCostIdx = idx("supplier_cost");
  const supplierPaidIdx = idx("supplier_paid");

  if (orderCodeIdx < 0) {
    return { ok: false, error: "CSV must include an order_code column" };
  }

  let updated = 0;
  let skipped = 0;

  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const order_code = cols[orderCodeIdx];
    if (!order_code) {
      skipped += 1;
      continue;
    }

    const supplier_name =
      supplierNameIdx >= 0 ? String(cols[supplierNameIdx] || "").replace(/^"|"$/g, "") : "";
    const supplier_cost =
      supplierCostIdx >= 0 ? Math.trunc(Number(cols[supplierCostIdx] || 0)) : 0;
    const supplier_paid =
      supplierPaidIdx >= 0 ? ["1", "true", "yes"].includes(String(cols[supplierPaidIdx]).toLowerCase()) : false;

    const res = upsertOrderMeta({
      order_code,
      supplier_cost,
      supplier_paid,
      supplier_name: supplier_name || undefined,
      requireSupplier: false,
    });

    if (res?.ok === false) {
      skipped += 1;
    } else {
      updated += 1;
    }
  }

  return { ok: true, updated, skipped, total: lines.length - 1 };
}

function importOrdersCsvFromFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return importOrdersCsv(text);
}

function enrichBillLinesFromApiOrder(orderDetail, supplierCostLbp, usdToLbpRate) {
  const items = normalizeOrderDetailItems(orderDetail);
  const supplierCostUsd = Number(supplierCostLbp || 0) / Number(usdToLbpRate || 90000);
  const totalSaleLbp = items.reduce((sum, d) => sum + Number(d.total || 0), 0);

  return items.map((detail) => {
    const item = detail.item || {};
    const qty = Number(detail.quantity || 0) || 1;
    const lineTotalLbp = Number(detail.total || 0);
    const share = totalSaleLbp > 0 ? lineTotalLbp / totalSaleLbp : 0;
    const lineCostUsd = share * supplierCostUsd;
    return {
      item_name: item.ref || item.item_name || item.name || "Item",
      barcode: item.barcode || "",
      brand: item.brand || "",
      quantity: qty,
      unit_cost_usd: qty > 0 ? lineCostUsd / qty : 0,
      line_cost_usd: lineCostUsd,
    };
  });
}

function usdToDisplay(usd, displayCurrency, usdToLbpRate) {
  if (displayCurrency === "LBP") return Math.round(Number(usd || 0) * usdToLbpRate);
  return Math.round(Number(usd || 0) * 100) / 100;
}

function getOrderBillDataList(orderCode, apiOrderDetail) {
  const cfg = getWalletConfig() || {};
  const usdToLbpRate = Number(cfg.usdToLbpRate || 90000);
  const displayCurrency = String(cfg.displayCurrency || "USD").toUpperCase();

  const { orders } = computeOrders();
  const summary = orders.find((o) => o.order_code === orderCode) || null;

  const supplier_cost_lbp = summary?.supplier_cost || 0;
  const supplier_name = summary?.supplier_name || "(Unassigned)";
  const supplier_phone = summary?.supplier_phone || "";
  const supplier_paid = !!(summary?.supplier_paid);

  const db = getDb();
  const lineMetaRows = getLineMetaForOrder(orderCode);
  const lineMetaByBarcode = new Map(lineMetaRows.map((l) => [l.barcode, l]));

  const salesRows = db
    .prepare(
      `
    SELECT s.quantity, s.cost, s.total_sale, s.unit_price,
           p.item_name, p.barcode, p.brand
    FROM sales s
    LEFT JOIN products p ON p.id = s.product_id
    WHERE s.order_code = ?
    ORDER BY p.item_name
  `
    )
    .all(orderCode);

  let lines = salesRows.map((r) => {
    const qty = Number(r.quantity || 0);
    const lm = lineMetaByBarcode.get(r.barcode);
    const lineCostUsd = lm
      ? Number(lm.supplier_cost_lbp || 0) / usdToLbpRate
      : Number(r.cost || 0);
    return {
      item_name: r.item_name || r.barcode || "Item",
      barcode: r.barcode || "",
      brand: r.brand || "",
      quantity: qty,
      unit_cost_usd: qty > 0 ? lineCostUsd / qty : 0,
      line_cost_usd: lineCostUsd,
      supplier_id: lm?.supplier_id || null,
      supplier_name: lm?.supplier_name || "",
      supplier_phone: lm?.supplier_phone || "",
      supplier_paid: lm ? !!lm.supplier_paid : false,
    };
  });

  if (!lines.length && apiOrderDetail?.length) {
    lines = enrichBillLinesFromApiOrder(apiOrderDetail, supplier_cost_lbp, usdToLbpRate)
      .map((line) => {
        const lm = lineMetaByBarcode.get(line.barcode);
        const lineCostUsd = lm
          ? Number(lm.supplier_cost_lbp || 0) / usdToLbpRate
          : line.line_cost_usd;
        return {
          ...line,
          unit_cost_usd: line.quantity > 0 ? lineCostUsd / line.quantity : 0,
          line_cost_usd: lineCostUsd,
          supplier_id: lm?.supplier_id || null,
          supplier_name: lm?.supplier_name || "",
          supplier_phone: lm?.supplier_phone || "",
          supplier_paid: lm ? !!lm.supplier_paid : false,
        };
      });
  }

  const linesWithDisplay = lines.map((l) => ({
    ...l,
    unit_cost_display: usdToDisplay(l.unit_cost_usd, displayCurrency, usdToLbpRate),
    line_cost_display: usdToDisplay(l.line_cost_usd, displayCurrency, usdToLbpRate),
  }));

  const common = {
    order_code: orderCode,
    merchant_payout_lbp: summary?.merchant_payout || 0,
    gross_lbp: summary?.gross || 0,
    order_date: summary?.primary_date || String(summary?.dates || "").split(" | ")[0] || "",
    display_currency: displayCurrency,
    usd_to_lbp_rate: usdToLbpRate,
  };

  const buildBill = (billSupplier, billLines, fallbackCostLbp = 0) => {
    const totalCostUsd = billLines.length
      ? billLines.reduce((sum, line) => sum + Number(line.line_cost_usd || 0), 0)
      : Number(fallbackCostLbp || 0) / usdToLbpRate;
    const costLbp = Math.round(totalCostUsd * usdToLbpRate);
    return {
      ...common,
      supplier_id: billSupplier.id || null,
      supplier_name: billSupplier.name || "(Unassigned)",
      supplier_phone: billSupplier.phone || "",
      supplier_paid: !!billSupplier.paid,
      supplier_cost_lbp: costLbp,
      supplier_cost_usd: totalCostUsd,
      lines: billLines,
      total_cost_usd: totalCostUsd,
      total_cost_display: usdToDisplay(totalCostUsd, displayCurrency, usdToLbpRate),
    };
  };

  const hasLineSupplierAssignments = linesWithDisplay.some(
    (line) => line.supplier_id || line.supplier_name
  );
  if (!hasLineSupplierAssignments) {
    return [
      buildBill(
        { id: summary?.supplier_id, name: supplier_name, phone: supplier_phone, paid: supplier_paid },
        linesWithDisplay,
        supplier_cost_lbp
      ),
    ];
  }

  const groups = new Map();
  for (const line of linesWithDisplay) {
    const key = line.supplier_id
      ? "id:" + line.supplier_id
      : line.supplier_name
        ? "name:" + line.supplier_name
        : "unassigned";
    if (!groups.has(key)) {
      groups.set(key, {
        supplier: {
          id: line.supplier_id || null,
          name: line.supplier_name || "(Unassigned)",
          phone: line.supplier_phone || "",
          paid: true,
        },
        lines: [],
      });
    }
    const group = groups.get(key);
    group.lines.push(line);
    if (Number(line.line_cost_usd || 0) > 0 && !line.supplier_paid) {
      group.supplier.paid = false;
    }
  }

  return Array.from(groups.values())
    .map((group) => buildBill(group.supplier, group.lines))
    .sort((a, b) => a.supplier_name.localeCompare(b.supplier_name));
}

function getOrderBillData(orderCode, apiOrderDetail) {
  return getOrderBillDataList(orderCode, apiOrderDetail)[0] || null;
}

module.exports = {
  computeOrders,
  getOrdersReconciliation,
  getSupplierSummary,
  getWalletRevenueByPeriod,
  getTotals,
  upsertOrderMeta,
  getLineMetaForOrder,
  upsertLineMeta,
  setOrderAdjustedFlag,
  resetSupplierMeta,
  exportOrdersCsv,
  importOrdersCsv,
  importOrdersCsvFromFile,
  getOrderBillData,
  getOrderBillDataList,
};
