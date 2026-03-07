const { getOrders, getOrderDetails } = require("./totersApi");
const { recordOrderItemsToSales } = require("../db/sales");

// We keep both an array and a map for fast lookup
let cachedOrders = [];
let cachedByCode = new Map();

async function syncOrders(storeId) {
  const result = await getOrders(storeId);

  const list =
    result?.data?.orders?.data ?? result?.orders?.data ?? result?.data ?? result ?? [];

  cachedOrders = Array.isArray(list) ? list : [];
  cachedByCode = new Map(cachedOrders.map((o) => [o.code, o]));

  return cachedOrders;
}

function findByCode(code) {
  return cachedByCode.get(code) || null;
}

async function loadDetailsByCode(code) {
  const summary = findByCode(code);
  if (!summary?.id) return null;

  const details = await getOrderDetails(summary.id);
  const detailedOrder = details?.data?.orders || details;

  const finalOrder = {
    ...detailedOrder,
    ...summary,
    order_detail: detailedOrder?.order_detail || [],
  };

  // When we load an order, reconcile inventory and sales
  recordOrderItemsToSales(finalOrder);

  return finalOrder;
}

module.exports = { syncOrders, loadDetailsByCode };
