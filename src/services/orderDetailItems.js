function mapDetailLine(detail) {
  const orderedQty = Number(detail.quantity ?? 0);
  const hasFinalQty =
    detail.final_quantity != null && detail.final_quantity !== "";
  const finalQty = hasFinalQty ? Number(detail.final_quantity) : orderedQty;

  const orderedTotal = Number(detail.total ?? 0);
  const hasFinalTotal = detail.final_total != null && detail.final_total !== "";
  const finalTotal = hasFinalTotal ? Number(detail.final_total) : orderedTotal;

  const wasAdjusted =
    (hasFinalQty && finalQty !== orderedQty) ||
    (hasFinalTotal && finalTotal !== orderedTotal);

  return {
    ...detail,
    ordered_quantity: orderedQty,
    quantity: finalQty,
    ordered_total: orderedTotal,
    total: finalTotal,
    was_adjusted: wasAdjusted,
  };
}

function normalizeOrderDetailItems(orderDetail) {
  if (!orderDetail) return [];

  let rawItems = [];

  if (Array.isArray(orderDetail)) {
    rawItems = orderDetail;
  } else if (typeof orderDetail === "object") {
    if (Array.isArray(orderDetail.adjusted_items) && orderDetail.adjusted_items.length) {
      rawItems = orderDetail.adjusted_items;
    } else if (Array.isArray(orderDetail.items) && orderDetail.items.length) {
      rawItems = orderDetail.items;
    } else if (Array.isArray(orderDetail.data) && orderDetail.data.length) {
      rawItems = orderDetail.data;
    }
  }

  return rawItems.map(mapDetailLine);
}

function countAdjustedItems(orderDetail) {
  return normalizeOrderDetailItems(orderDetail).filter((d) => d.was_adjusted).length;
}

module.exports = {
  normalizeOrderDetailItems,
  mapDetailLine,
  countAdjustedItems,
};
