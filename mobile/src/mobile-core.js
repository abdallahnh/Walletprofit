(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MobileCore = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DEFAULT_CATEGORIES = [
    "Papers",
    "Phone recharge",
    "Bags",
    "Packaging",
    "Office supplies",
    "Other",
  ];
  const DEFAULT_COLORS = [
    "#dbeafe", "#fce7f3", "#dcfce7", "#fef3c7",
    "#ede9fe", "#ffedd5", "#e0f2fe", "#f3e8ff",
  ];

  function emptyData() {
    return {
      schema_version: 2,
      exported_at: new Date().toISOString(),
      transactions: [],
      suppliers: [],
      order_meta: [],
      order_line_meta: [],
      order_items: [],
      products: [],
      sales: [],
      product_price_history: [],
      company_expenses: [],
      config: [],
      walletConfig: {
        baseUrl: "https://dashboard.toters-api.com",
        storeId: "",
        wallet: "main",
        token: "",
        usdToLbpRate: 90000,
        displayCurrency: "USD",
      },
    };
  }

  function normalizeData(value) {
    const base = emptyData();
    const data = value && typeof value === "object" ? value : {};
    for (const key of [
      "transactions", "suppliers", "order_meta", "order_line_meta", "order_items", "products",
      "sales", "product_price_history", "company_expenses", "config",
    ]) {
      base[key] = Array.isArray(data[key]) ? data[key] : [];
    }
    base.schema_version = Number(data.schema_version || base.schema_version);
    base.exported_at = data.exported_at || base.exported_at;
    base.walletConfig = data.walletConfig && typeof data.walletConfig === "object"
      ? { ...base.walletConfig, ...data.walletConfig }
      : base.walletConfig;
    return base;
  }

  function extractOrderCode(reason) {
    const match = String(reason || "").match(/order\s+(\d{3,}-\d{3,})/i);
    return match ? match[1] : null;
  }

  function parseWalletSummaryEntry(storeData, walletName) {
    const summary = Array.isArray(storeData?.summary) ? storeData.summary : [];
    const requestedWallet = String(walletName || "main");
    const row = summary.find((item) => item?.wallet === requestedWallet) || summary[0];
    if (!row) return null;

    const rawAmount = Number(row.amount) || 0;
    return {
      raw_amount_lbp: rawAmount,
      remaining_from_toters_lbp: rawAmount < 0 ? Math.abs(rawAmount) : 0,
      wallet: row.wallet || requestedWallet,
      store_name: storeData?.store?.ref || "",
      currency_ref: storeData?.store?.currency?.ref || "LBP",
    };
  }

  function normalizeType(type) {
    const value = String(type || "").trim().toLowerCase();
    if (value === "gross_app_revenue" || value.includes("gross")) return "gross";
    if (value === "store_listing_fee" || value.includes("store listing") || value.includes("service fee")) return "service_fee";
    if (value === "value_added_tax" || value.includes("value added") || value.includes("vat")) return "vat";
    if (value === "merchant_incentive" || value.includes("merchant incentive") || value.includes("cashback")) return "incentive";
    if (value === "balance_settlement" || value.includes("settlement")) return "settlement";
    if (value === "marketing_immediate_discount" || value.includes("marketing")) return "marketing";
    return "other";
  }

  function classifyTransaction(type, reason) {
    if (/wrong\s*\/\s*missing/i.test(String(reason || ""))) return "wrong_missing";
    return normalizeType(type);
  }

  function normalizeColor(color, fallbackId) {
    const value = String(color || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    if (fallbackId != null) return DEFAULT_COLORS[Math.abs(Number(fallbackId)) % DEFAULT_COLORS.length];
    return "#e8f4fc";
  }

  function nextId(rows) {
    return rows.reduce((max, row) => Math.max(max, Number(row.id || 0)), 0) + 1;
  }

  function supplierMaps(data) {
    const byId = new Map(data.suppliers.map((supplier) => [Number(supplier.id), supplier]));
    return { byId };
  }

  function lineMetaForOrder(data, orderCode) {
    const { byId } = supplierMaps(data);
    const saleByBarcode = new Map(
      data.sales
        .filter((sale) => sale.order_code === orderCode)
        .map((sale) => [String(sale.barcode || ""), sale])
    );
    const itemByBarcode = new Map(
      data.order_items
        .filter((item) => item.order_code === orderCode && item.barcode)
        .map((item) => [String(item.barcode), item])
    );
    return data.order_line_meta
      .filter((line) => line.order_code === orderCode)
      .map((line) => {
        const supplier = byId.get(Number(line.supplier_id));
        const sale = saleByBarcode.get(String(line.barcode || ""));
        const orderItem = itemByBarcode.get(String(line.barcode || ""));
        const product = data.products.find((item) => String(item.barcode || "") === String(line.barcode || ""));
        return {
          ...line,
          supplier_id: line.supplier_id ? Number(line.supplier_id) : null,
          supplier_name: supplier?.name || "",
          supplier_phone: supplier?.phone || "",
          supplier_color: normalizeColor(supplier?.color, supplier?.id),
          supplier_cost_lbp: Number(line.supplier_cost_lbp || 0),
          supplier_paid: line.supplier_paid ? 1 : 0,
          total_sale: Number(sale?.total_sale || 0),
          quantity: Number(orderItem?.quantity ?? sale?.quantity ?? 0),
          item_name: orderItem?.item_name_snapshot || product?.item_name || line.barcode || "Item",
          image_url_snapshot: orderItem?.image_url_snapshot || null,
          unit_supplier_cost_usd: orderItem?.unit_supplier_cost_usd ?? null,
          catalog_sync_status: orderItem?.catalog_sync_status || null,
        };
      });
  }

  function computeOrders(rawData) {
    const data = normalizeData(rawData);
    const byOrder = new Map();
    let settlementsTotal = 0;
    for (const transaction of data.transactions) {
      const type = normalizeType(transaction.type);
      const amount = Number(transaction.amount || 0);
      if (type === "settlement") {
        settlementsTotal += amount;
        continue;
      }
      const orderCode = transaction.order_code || extractOrderCode(transaction.reason);
      if (!orderCode) continue;
      if (!byOrder.has(orderCode)) {
        byOrder.set(orderCode, {
          order_code: orderCode,
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
      const row = byOrder.get(orderCode);
      row.row_count += 1;
      row.types.add(type);
      if (transaction.created_at) row.dates.add(transaction.created_at);
      if (type === "gross") row.gross += -amount;
      else if (type === "service_fee") row.service_fee += amount;
      else if (type === "vat") row.vat += amount;
      else if (type === "incentive") row.incentive += Math.abs(amount);
      else if (type === "marketing") row.marketing += Math.abs(amount);
    }

    const { byId: suppliers } = supplierMaps(data);
    const metaByOrder = new Map(data.order_meta.map((meta) => [meta.order_code, meta]));
    const salesByOrder = new Map();
    for (const sale of data.sales) {
      if (!salesByOrder.has(sale.order_code)) salesByOrder.set(sale.order_code, []);
      salesByOrder.get(sale.order_code).push(sale);
    }

    const orders = [];
    for (const aggregate of byOrder.values()) {
      const meta = metaByOrder.get(aggregate.order_code) || {};
      const supplier = suppliers.get(Number(meta.supplier_id));
      const lines = lineMetaForOrder(data, aggregate.order_code);
      const lineSupplierIds = [...new Set(lines.map((line) => line.supplier_id).filter(Boolean))];
      const lineCost = lines.reduce((sum, line) => sum + Number(line.supplier_cost_lbp || 0), 0);
      const allPositiveLinesPaid = lines.every(
        (line) => Number(line.supplier_cost_lbp || 0) <= 0 || !!line.supplier_paid
      );
      const saleRows = salesByOrder.get(aggregate.order_code) || [];
      const storedItems = data.order_items.filter((item) => item.order_code === aggregate.order_code);
      const itemCount = Math.max(storedItems.length, saleRows.length, lines.length, 1);
      const supplierNames = [...new Set(lines.map((line) => line.supplier_name).filter(Boolean))];
      const supplierCost = lines.length ? lineCost : Number(meta.supplier_cost || 0);
      const supplierPaid = lines.length ? allPositiveLinesPaid : !!meta.supplier_paid;
      const merchantPayout = aggregate.gross - aggregate.service_fee - aggregate.vat + aggregate.incentive - aggregate.marketing;
      const dates = [...aggregate.dates].sort();
      const expectedTypes = ["gross", "service_fee", "vat"];
      const missingTypes = expectedTypes.filter((type) => !aggregate.types.has(type));
      const normalizedItems = storedItems.length ? storedItems.map((item) => ({
        barcode: item.barcode,
        item_name: item.item_name_snapshot || item.barcode,
        quantity: Number(item.quantity || 0),
        image_url: item.image_url_snapshot || null,
        vendor_price_usd: item.unit_supplier_cost_usd ?? null,
        supplier_id: item.supplier_id || null,
        merchant_code: item.merchant_code || null,
        catalog_sync_status: item.catalog_sync_status || null,
        catalog_error: item.catalog_error || null,
      })) : saleRows.map((sale) => {
        const product = data.products.find((item) => Number(item.id) === Number(sale.product_id)) || {};
        return {
          barcode: sale.barcode,
          item_name: sale.item_name_snapshot || product.item_name || sale.barcode,
          quantity: Number(sale.quantity || 0),
          total_sale: Number(sale.total_sale || 0),
        };
      });
      const unresolvedItems = normalizedItems.filter((item) =>
        item.catalog_sync_status && item.catalog_sync_status !== "matched"
      );
      const hasUnknownSupplierCost = unresolvedItems.length > 0 && meta.cost_source !== "manual_override";
      orders.push({
        order_code: aggregate.order_code,
        gross: aggregate.gross,
        service_fee: aggregate.service_fee,
        vat: aggregate.vat,
        incentive: aggregate.incentive,
        marketing: aggregate.marketing,
        merchant_payout: merchantPayout,
        toters_margin: aggregate.service_fee + aggregate.vat - aggregate.incentive,
        supplier_cost: supplierCost,
        supplier_paid: supplierPaid ? 1 : 0,
        supplier_id: lines.length && lineSupplierIds.length === 1 ? lineSupplierIds[0] : (meta.supplier_id || null),
        supplier_name: lines.length ? supplierNames.join(", ") : (supplier?.name || ""),
        supplier_color: supplier ? normalizeColor(supplier.color, supplier.id) : "",
        supplier_phone: supplier?.phone || "",
        supplier_line_ids: lineSupplierIds.length ? lineSupplierIds : (meta.supplier_id ? [Number(meta.supplier_id)] : []),
        net_profit: hasUnknownSupplierCost ? null : merchantPayout - supplierCost,
        has_unknown_supplier_cost: hasUnknownSupplierCost ? 1 : 0,
        missing_supplier_cost_items: unresolvedItems.length,
        row_count: aggregate.row_count,
        primary_date: dates[0] || "",
        latest_date: dates[dates.length - 1] || dates[0] || "",
        dates: dates.slice(0, 6).join(" | ") + (dates.length > 6 ? " ..." : ""),
        transaction_types: [...aggregate.types].filter((type) => type !== "other").join(","),
        missing_types: missingTypes.join(","),
        has_missing_types: missingTypes.length ? 1 : 0,
        has_adjusted_items: meta.has_adjusted_items ? 1 : 0,
        adjusted_items_count: Number(meta.adjusted_items_count || 0),
        item_count: itemCount,
        is_splittable: itemCount > 1,
        is_multi_supplier: lineSupplierIds.length > 1,
        line_meta: lines,
        order_items: normalizedItems,
      });
    }
    orders.sort((left, right) =>
      String(right.latest_date || "").localeCompare(String(left.latest_date || "")) ||
      String(right.order_code || "").localeCompare(String(left.order_code || ""))
    );
    return { orders, settlementsTotal };
  }

  function filterOrders(orders, opts) {
    const options = opts || {};
    const supplierIds = Array.isArray(options.supplierIds)
      ? options.supplierIds.map(Number).filter(Boolean)
      : [];
    return orders.filter((order) => {
      const date = String(order.latest_date || order.primary_date || "").slice(0, 10);
      if (options.from && date && date < options.from) return false;
      if (options.to && date && date > options.to) return false;
      if (supplierIds.length) {
        const ids = order.supplier_line_ids || [];
        if (!supplierIds.includes(Number(order.supplier_id)) && !ids.some((id) => supplierIds.includes(Number(id)))) return false;
      }
      return true;
    });
  }

  function getTotals(data, opts) {
    const computed = computeOrders(data);
    const orders = filterOrders(computed.orders, opts);
    const totals = {
      orders: orders.length,
      gross: 0,
      service_fee: 0,
      vat: 0,
      incentive: 0,
      marketing: 0,
      merchantPayout: 0,
      totersMargin: 0,
      supplierCost: 0,
      netProfit: 0,
      settlements: computed.settlementsTotal,
      netProfitWithSettlements: opts?.includeSettlements ? 0 : null,
    };
    for (const order of orders) {
      totals.gross += Number(order.gross || 0);
      totals.service_fee += Number(order.service_fee || 0);
      totals.vat += Number(order.vat || 0);
      totals.incentive += Number(order.incentive || 0);
      totals.marketing += Number(order.marketing || 0);
      totals.merchantPayout += Number(order.merchant_payout || 0);
      totals.totersMargin += Number(order.toters_margin || 0);
      totals.supplierCost += Number(order.supplier_cost || 0);
      totals.netProfit += Number(order.net_profit || 0);
    }
    if (opts?.includeSettlements) totals.netProfitWithSettlements = totals.netProfit + totals.settlements;
    return totals;
  }

  function getSupplierSummary(data, opts) {
    const orders = filterOrders(computeOrders(data).orders, opts);
    const selected = Array.isArray(opts?.supplierIds) ? opts.supplierIds.map(Number) : [];
    const result = new Map();
    const add = (id, name, revenue, cost, paid, orderShare, quantity, barcode) => {
      const key = Number(id || 0);
      if (selected.length && (!key || !selected.includes(key))) return;
      if (!result.has(key)) result.set(key, {
        supplier_id: key || null,
        supplier_name: name || "(Unassigned)",
        orders: 0,
        revenue: 0,
        supplier_cost: 0,
        payable: 0,
        profit: 0,
        units_sold: 0,
        _products: new Set(),
      });
      const row = result.get(key);
      row.orders += orderShare;
      row.revenue += revenue;
      row.supplier_cost += cost;
      if (!paid) row.payable += cost;
      row.profit += revenue - cost;
      row.units_sold += Number(quantity || 0);
      if (barcode) row._products.add(barcode);
    };
    for (const order of orders) {
      if (order.line_meta?.length) {
        const basis = order.line_meta.reduce((sum, line) => sum + Number(line.total_sale || 0), 0) || order.line_meta.length;
        for (const line of order.line_meta) {
          const share = basis ? (Number(line.total_sale || 0) || 1) / basis : 1 / order.line_meta.length;
          add(line.supplier_id, line.supplier_name, Math.round(order.merchant_payout * share), Number(line.supplier_cost_lbp || 0), !!line.supplier_paid, share, line.quantity, line.barcode);
        }
      } else {
        const items=(order.order_items||[]).filter(item=>!order.supplier_id||!item.supplier_id||Number(item.supplier_id)===Number(order.supplier_id));
        add(order.supplier_id, order.supplier_name, Number(order.merchant_payout || 0), Number(order.supplier_cost || 0), !!order.supplier_paid, 1, items.reduce((sum,item)=>sum+Number(item.quantity||0),0));
        const row=result.get(Number(order.supplier_id||0));
        if(row)for(const item of items)if(item.barcode)row._products.add(item.barcode);
      }
    }
    return [...result.values()].map(row=>({...row,product_count:row._products.size,_products:undefined})).sort((a, b) => a.supplier_name.localeCompare(b.supplier_name));
  }

  function getTransactions(data, opts) {
    let rows = normalizeData(data).transactions.map((row) => ({
      ...row,
      amount: Number(row.amount || 0),
      order_code: row.order_code || extractOrderCode(row.reason),
      normalized_type: classifyTransaction(row.type, row.reason),
    }));
    if (opts?.type && opts.type !== "all") rows = rows.filter((row) => row.normalized_type === opts.type);
    return rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || Number(b.id) - Number(a.id));
  }

  function getExpenses(data, opts) {
    return normalizeData(data).company_expenses
      .filter((row) => {
        if (opts?.from && row.expense_date < opts.from) return false;
        if (opts?.to && row.expense_date > opts.to) return false;
        if (opts?.category && opts.category !== "all" && row.category !== opts.category) return false;
        return true;
      })
      .map((row) => ({ ...row, amount_lbp: Number(row.amount_lbp || 0) }))
      .sort((a, b) => String(b.expense_date || "").localeCompare(String(a.expense_date || "")) || Number(b.id) - Number(a.id));
  }

  function filterSales(data, opts) {
    const normalized = normalizeData(data);
    const orders = new Map(normalized.order_meta.map((meta) => [meta.order_code, meta]));
    const ids = Array.isArray(opts?.supplierIds) ? opts.supplierIds.map(Number).filter(Boolean) : [];
    return normalized.sales.filter((sale) => {
      const date = String(sale.created_at || "").slice(0, 10);
      if (opts?.from && date < opts.from) return false;
      if (opts?.to && date > opts.to) return false;
      if (ids.length && !ids.includes(Number(orders.get(sale.order_code)?.supplier_id))) return false;
      return true;
    });
  }

  function salesReport(data, opts) {
    const normalized = normalizeData(data);
    const products = new Map(normalized.products.map((product) => [Number(product.id), product]));
    const grouped = new Map();
    for (const sale of filterSales(normalized, opts)) {
      const product = products.get(Number(sale.product_id)) || normalized.products.find((item) => item.barcode === sale.barcode) || {};
      const key = sale.barcode || product.barcode || String(sale.product_id);
      if (!grouped.has(key)) grouped.set(key, {
        barcode: key,
        item_name: sale.item_name_snapshot || product.item_name || key,
        brand: product.brand || "",
        unit_price: Number(product.unit_price_usd || 0),
        cost_price: Number(product.cost_usd || 0),
        sold_qty: 0,
        revenue: 0,
        supplier_cost: 0,
        profit: 0,
        missing_cost_rows: 0,
      });
      const row = grouped.get(key);
      row.sold_qty += Number(sale.quantity || 0);
      row.revenue += Number(sale.total_sale || 0);
      if (sale.cost == null || sale.profit == null) row.missing_cost_rows += 1;
      else {
        row.supplier_cost += Number(sale.cost);
        row.profit += Number(sale.profit);
      }
    }
    return [...grouped.values()].map((row) => ({
      ...row,
      supplier_cost: row.missing_cost_rows ? null : row.supplier_cost,
      profit: row.missing_cost_rows ? null : row.profit,
      cost_status: row.missing_cost_rows ? "Missing Vendor Price" : "complete",
    })).sort((a, b) => b.sold_qty - a.sold_qty);
  }

  function periodKey(date, period) {
    const value = String(date || "").slice(0, 10);
    if (period === "month") return value.slice(0, 7);
    if (period === "week") {
      const parsed = new Date(`${value}T12:00:00`);
      const start = new Date(parsed.getFullYear(), 0, 1);
      const week = Math.floor((parsed - start) / 604800000);
      return `${parsed.getFullYear()}-${String(week).padStart(2, "0")}`;
    }
    return value;
  }

  function salesRevenueByPeriod(data, opts) {
    const grouped = new Map();
    for (const sale of filterSales(data, opts)) {
      const key = periodKey(sale.created_at, opts?.period || "day");
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, { period: key, revenue: 0, cost: 0, profit: 0, quantity_sold: 0, order_codes: new Set() });
      const row = grouped.get(key);
      row.revenue += Number(sale.total_sale || 0);
      row.cost += Number(sale.cost || 0);
      row.profit += Number(sale.profit || 0);
      row.quantity_sold += Number(sale.quantity || 0);
      row.order_codes.add(sale.order_code);
    }
    return [...grouped.values()].map((row) => ({ ...row, order_count: row.order_codes.size, order_codes: undefined })).sort((a, b) => a.period.localeCompare(b.period));
  }

  function walletRevenueByPeriod(data, opts) {
    const grouped = new Map();
    for (const order of filterOrders(computeOrders(data).orders, opts)) {
      const key = periodKey(order.latest_date || order.primary_date, opts?.period || "day");
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, { period: key, revenue: 0, cost: 0, profit: 0, quantity_sold: 0, order_count: 0, missing_cost_orders: 0 });
      const row = grouped.get(key);
      row.revenue += Number(order.merchant_payout || 0);
      if (order.has_unknown_supplier_cost) {
        row.missing_cost_orders += 1;
        row.cost = null;
        row.profit = null;
      } else {
        if (row.cost != null) row.cost += Number(order.supplier_cost || 0);
        if (row.profit != null) row.profit += Number(order.net_profit || 0);
      }
      row.quantity_sold += Number(order.row_count || 0);
      row.order_count += 1;
    }
    return [...grouped.values()].sort((a, b) => a.period.localeCompare(b.period));
  }

  function upsertBy(rows, predicate, value) {
    const index = rows.findIndex(predicate);
    if (index >= 0) rows[index] = { ...rows[index], ...value };
    else rows.push(value);
    return value;
  }

  function buildBillDataList(rawData, orderCode) {
    const data = normalizeData(rawData);
    const order = computeOrders(data).orders.find((item) => item.order_code === orderCode);
    if (!order) return [];
    const config = data.walletConfig || {};
    const rate = Number(config.usdToLbpRate || 90000);
    const currency = String(config.displayCurrency || "USD").toUpperCase();
    const sales = data.sales.filter((sale) => sale.order_code === orderCode);
    const lineMeta = lineMetaForOrder(data, orderCode);
    const lines = sales.map((sale) => {
      const product = data.products.find((item) => Number(item.id) === Number(sale.product_id)) || {};
      const meta = lineMeta.find((item) => String(item.barcode) === String(sale.barcode));
      const quantity = Number(sale.quantity || 0) || 1;
      const lineCostUsd = meta ? Number(meta.supplier_cost_lbp || 0) / rate : Number(sale.cost || 0);
      return {
        item_name: product.item_name || sale.barcode || "Item",
        barcode: sale.barcode || "",
        brand: product.brand || "",
        quantity,
        unit_cost_usd: lineCostUsd / quantity,
        line_cost_usd: lineCostUsd,
        unit_cost_display: currency === "LBP" ? Math.round(lineCostUsd / quantity * rate) : lineCostUsd / quantity,
        line_cost_display: currency === "LBP" ? Math.round(lineCostUsd * rate) : lineCostUsd,
        supplier_id: meta?.supplier_id || order.supplier_id || null,
        supplier_name: meta?.supplier_name || order.supplier_name || "(Unassigned)",
        supplier_phone: meta?.supplier_phone || order.supplier_phone || "",
        supplier_paid: meta ? !!meta.supplier_paid : !!order.supplier_paid,
      };
    });
    const groups = new Map();
    for (const line of lines) {
      const key = line.supplier_id ? `id:${line.supplier_id}` : `name:${line.supplier_name}`;
      if (!groups.has(key)) groups.set(key, { supplier_id: line.supplier_id, supplier_name: line.supplier_name, supplier_phone: line.supplier_phone, supplier_paid: true, lines: [] });
      const group = groups.get(key);
      group.lines.push(line);
      if (line.line_cost_usd > 0 && !line.supplier_paid) group.supplier_paid = false;
    }
    if (!groups.size) groups.set("empty", { supplier_id: order.supplier_id, supplier_name: order.supplier_name || "(Unassigned)", supplier_phone: order.supplier_phone || "", supplier_paid: !!order.supplier_paid, lines: [] });
    return [...groups.values()].map((group) => {
      const totalUsd = group.lines.reduce((sum, line) => sum + Number(line.line_cost_usd || 0), 0) || Number(order.supplier_cost || 0) / rate;
      return {
        order_code: orderCode,
        ...group,
        supplier_cost_lbp: Math.round(totalUsd * rate),
        supplier_cost_usd: totalUsd,
        merchant_payout_lbp: order.merchant_payout,
        gross_lbp: order.gross,
        order_date: order.primary_date,
        display_currency: currency,
        usd_to_lbp_rate: rate,
        total_cost_usd: totalUsd,
        total_cost_display: currency === "LBP" ? Math.round(totalUsd * rate) : totalUsd,
      };
    }).sort((a, b) => a.supplier_name.localeCompare(b.supplier_name));
  }

  return {
    DEFAULT_CATEGORIES,
    emptyData,
    normalizeData,
    normalizeType,
    classifyTransaction,
    extractOrderCode,
    parseWalletSummaryEntry,
    normalizeColor,
    nextId,
    lineMetaForOrder,
    computeOrders,
    filterOrders,
    getTotals,
    getSupplierSummary,
    getTransactions,
    getExpenses,
    salesReport,
    salesRevenueByPeriod,
    walletRevenueByPeriod,
    upsertBy,
    buildBillDataList,
  };
});
