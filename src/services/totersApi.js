let authToken = null;
let baseUrl = "https://dashboard.toters-api.com/api";
let ordersRequestSequence = 0;

function setAuthToken(token) {
  authToken = token;
}

function setBaseUrl(url) {
  const parsed = new URL(String(url || ""));
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("Base URL must use HTTP or HTTPS");
  }
  parsed.hash = "";
  parsed.search = "";
  baseUrl = parsed.toString().replace(/\/$/, "") + "/api";
}

async function httpGet(url, extraHeaders = {}) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${authToken}`,
      "Accept": "application/json",
      ...extraHeaders,
    }
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) {
    const msg = typeof json === "object" ? JSON.stringify(json) : String(json);
    throw new Error(`Fetch failed (${res.status}): ${msg}`);
  }
  return json;
}

// IMPORTANT: Your /orders needs store_id in BODY? (unusual for GET)
// If Toters actually requires POST, tell me and I’ll adapt.
// For now, we do GET with query param store_id (most common)
async function getOrders(storeId, page = 1) {
  // Toters/CDN can retain the exact orders-list URL after new wallet rows have
  // already appeared. A unique query value plus no-cache headers ensures each
  // sync cycle sees the current order list instead of a stale page-one response.
  ordersRequestSequence += 1;
  const freshness = `${Date.now()}-${ordersRequestSequence}`;
  const url =
    `${baseUrl}/orders?store_id=${encodeURIComponent(storeId)}` +
    `&page=${encodeURIComponent(page)}&_sync=${encodeURIComponent(freshness)}`;
  return await httpGet(url, {
    "Cache-Control": "no-cache, no-store, max-age=0",
    "Pragma": "no-cache",
  });
}

async function getOrderDetails(orderId) {
  const url = `${baseUrl}/orders/${encodeURIComponent(orderId)}`;
  return await httpGet(url);
}

module.exports = {
  setAuthToken,
  setBaseUrl,
  getOrders,
  getOrderDetails
};
