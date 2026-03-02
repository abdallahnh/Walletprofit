const { ipcRenderer } = require("electron");

ipcRenderer.on("order-data", (_, order) => {
  if (!order) return;

  console.log("ORDER DATA:", order);

  // -------- TITLE --------
  document.getElementById("orderTitle").innerText =
    `Order ${order.code} — ${order.status}`;

  
 // -------- CUSTOMER --------
const customer = order.client || {};
const address = order.address || {};
const opCity = order.op_city || {};

document.getElementById("customerInfo").innerHTML = `
  <div><b>Name:</b> ${customer.first_name || ""} ${customer.last_name || ""}</div>
  <div><b>Email:</b> ${customer.email || "-"}</div>
  <div><b>Phone:</b> ${customer.phone_number || "-"}</div>
  <div><b>Segment:</b> ${customer.activity_segment || "-"}</div>
  <div><b>Value Segment:</b> ${customer.value_segment || "-"}</div>
  <hr/>
  <div><b>City:</b> ${opCity.ref || "-"}</div>
  <div><b>Country:</b> ${opCity.country || "-"}</div>
  <div><b>Address Phone:</b> ${address.phone_number || "-"}</div>
  <div><b>Country Code:</b> ${address.country_code || "-"}</div>
`;
const a = order.address || {};
const addrText = [
  a.nickname && `(${a.nickname})`,
  a.street,
  a.apartment,
  a.building_ref && `Bldg: ${a.building_ref}`,
  a.instructions && `Notes: ${a.instructions}`
].filter(Boolean).join(" • ");

document.getElementById("address").textContent = addrText || "-";

const mapsLink = (a.lat && a.lon)
  ? `https://www.google.com/maps?q=${a.lat},${a.lon}`
  : null;

document.getElementById("maps").innerHTML =
  mapsLink ? `<a href="${mapsLink}">Open in Maps</a>` : "";

  // -------- SUMMARY --------
  document.getElementById("orderSummary").innerHTML = `
    <div><b>Total:</b> ${order.total}</div>
    <div><b>Items Total:</b> ${order.items_total}</div>
    <div><b>Delivery:</b> ${order.delivery_charge}</div>
    <div><b>Tip:</b> ${order.tip}</div>
    <div><b>Payment:</b> ${order.payment_type}</div>
    <div><b>Created:</b> ${order.created_at}</div>
  `;

  // -------- ITEMS --------
  const container = document.getElementById("itemsContainer");
  container.innerHTML = "";

  const items = order.order_detail || [];

  items.forEach(detail => {
    const item = detail.item || {};

    const div = document.createElement("div");
    div.className = "item-card";

    const image =
      item.image ||
      (item.imgs && item.imgs[0]) ||
      "https://via.placeholder.com/150";

    div.innerHTML = `
      <img src="${image}" />
      <div class="value">${item.ref || "-"}</div>
      <div class="label">Barcode: ${item.barcode || "-"}</div>
      <div class="label">Qty: ${detail.quantity}</div>
      <div class="label">Unit Price: ${detail.item_price}</div>
      <div class="label">Total: ${detail.total}</div>
    `;

    container.appendChild(div);
  });
});