const { getOrders, getOrderDetails } = require("./totersApi");

// We keep both an array and a map for fast lookup
let cachedOrders = [];
let cachedByCode = new Map();

async function syncOrders(storeId) {
  const result = await getOrders(storeId);

  // Your /orders response shape is: { errors:false, data:{ orders:{ data:[...] } } }
  const list = result?.data?.orders?.data ?? result?.orders?.data ?? result?.data ?? result ?? [];

  cachedOrders = Array.isArray(list) ? list : [];
  cachedByCode = new Map(cachedOrders.map(o => [o.code, o]));

  return cachedOrders;
}

function findByCode(code) {
  return cachedByCode.get(code) || null;
}

async function loadDetailsByCode(code) {
  const summary = findByCode(code);
  if (!summary?.id) return null;

  const details = await getOrderDetails(summary.id);
  const detailedOrder =
    details?.data?.orders || details;

  const finalOrder = {
    ...detailedOrder,   // first load detailed
    ...summary,         // THEN overwrite with summary (address safe)
    order_detail: detailedOrder?.order_detail || []
  };
  processOrderItems(finalOrder);
  return finalOrder;
}

module.exports = { syncOrders, loadDetailsByCode };
