let authToken = null;
let baseUrl = "https://dashboard.toters-api.com/api";

function setAuthToken(token) {
  authToken = token;
}

function setBaseUrl(url) {
  baseUrl = (url || "").replace(/\/$/, "") + "/api";
}

async function httpGet(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${authToken}`,
      "Accept": "application/json"
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
  const url = `${baseUrl}/orders?store_id=${encodeURIComponent(storeId)}&page=${page}`;
  return await httpGet(url);
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