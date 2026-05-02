const { getOrders, getOrderDetails } = require("./totersApi");
const { recordOrderItemsToSales } = require("../db/sales");

// We keep both an array and a map for fast lookup
let cachedOrders = [];
let cachedByCode = new Map();

async function syncOrders(storeId) {
  const all = [];
  let page = 1;
  let guard = 0;

  while (guard < 500) {
    guard += 1;
    const result = await getOrders(storeId, page);

    const list =
      result?.data?.orders?.data ?? result?.orders?.data ?? result?.data ?? result ?? [];
    const rows = Array.isArray(list) ? list : [];

    if (!rows.length) break;
    for (const row of rows) {
      // Some APIs wrap order summary under "order".
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
            code, // Some APIs accept order code on details endpoint.
          ]
            .map((v) => (v == null ? null : String(v).trim()))
            .filter(Boolean)
        )
      );
      all.push({ ...summary, code, id, _candidateIds: candidateIds });
    }

    const nextPageUrl =
      result?.data?.orders?.next_page_url ?? result?.orders?.next_page_url ?? null;
    if (!nextPageUrl) break;
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

  const finalOrder = {
    ...detailedOrder,
    ...summary,
    order_detail: detailedOrder?.order_detail || [],
  };

  // When we load an order, reconcile inventory and sales
  const salesSync = recordOrderItemsToSales(finalOrder);
  finalOrder._salesSync = salesSync;

  return finalOrder;
}

module.exports = { syncOrders, loadDetailsByCode };
