const { getOrders, getOrderDetails } = require("./totersApi");
const { recordOrderItemsToSales } = require("../db/sales");
const { setOrderAdjustedFlag } = require("../db/orders");
const { normalizeOrderDetailItems, countAdjustedItems } = require("./orderDetailItems");

// We keep both an array and a map for fast lookup
let cachedOrders = [];
let cachedByCode = new Map();

function parseOrdersPage(result) {
  const list =
    result?.data?.orders?.data ?? result?.orders?.data ?? result?.data ?? result ?? [];
  const rows = Array.isArray(list) ? list : [];
  const orders = [];

  for (const row of rows) {
    const summary = row?.order && typeof row.order === "object" ? row.order : row;
    const code = summary?.code ?? row?.code ?? null;
    const id = summary?.id ?? row?.id ?? row?.order_id ?? null;
    if (!code || !id) continue;
    const candidateIds = Array.from(
      new Set(
        [
          summary?.id,
          row?.id,
          summary?.order_id,
          row?.order_id,
          summary?.orderId,
          row?.orderId,
          code,
        ]
          .map((v) => (v == null ? null : String(v).trim()))
          .filter(Boolean)
      )
    );
    orders.push({ ...summary, code, id, _candidateIds: candidateIds });
  }

  const nextPageUrl =
    result?.data?.orders?.next_page_url ?? result?.orders?.next_page_url ?? null;
  return { orders, rawCount: rows.length, hasNextPage: !!nextPageUrl };
}

async function syncOrdersPage(storeId, page) {
  const parsed = parseOrdersPage(await getOrders(storeId, page));
  for (const order of parsed.orders) cachedByCode.set(order.code, order);
  cachedOrders = Array.from(cachedByCode.values());
  return parsed;
}

async function syncOrders(storeId) {
  const all = [];
  let page = 1;
  let guard = 0;

  while (guard < 500) {
    guard += 1;
    const result = parseOrdersPage(await getOrders(storeId, page));
    if (!result.rawCount) break;
    all.push(...result.orders);
    if (!result.hasNextPage) break;
    page += 1;
  }

  cachedOrders = all;
  cachedByCode = new Map(cachedOrders.map((o) => [o.code, o]));

  return cachedOrders;
}

function findByCode(code) {
  return cachedByCode.get(code) || null;
}

async function loadDetailsByCode(code) {
  const summary = findByCode(code);
  if (!summary) return null;

  const candidateIds = Array.isArray(summary._candidateIds) && summary._candidateIds.length
    ? summary._candidateIds
    : [summary.id, code].filter(Boolean).map((v) => String(v));

  let details = null;
  let lastErr = null;
  for (const candidate of candidateIds) {
    try {
      details = await getOrderDetails(candidate);
      if (details) break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!details) {
    throw lastErr || new Error(`Failed to load order details for code ${code}`);
  }

  const detailedOrder = details?.data?.orders || details;
  const order_detail = normalizeOrderDetailItems(detailedOrder?.order_detail);

  const finalOrder = {
    ...detailedOrder,
    ...summary,
    order_detail,
  };

  // When we load an order, reconcile inventory and sales
  const salesSync = recordOrderItemsToSales(finalOrder);
  finalOrder._salesSync = salesSync;

  setOrderAdjustedFlag(finalOrder.code, countAdjustedItems(order_detail));

  return finalOrder;
}

module.exports = { syncOrders, syncOrdersPage, loadDetailsByCode, parseOrdersPage };
