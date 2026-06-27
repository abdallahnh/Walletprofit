const { ipcRenderer } = require("electron");
const billExport = require("../db/billExport");

let currentBillData = null;

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatAmount(amount, currency) {
  return billExport.formatDisplayAmount(amount, currency);
}

function getCustomerPhones(order) {
  const client = order.client || order.customer || {};
  const address = order.address || {};

  const accountPhone = String(
    client.phone_number || client.phone || client.mobile || order.phone_number || ""
  ).trim();

  const deliveryPhone = String(
    address.phone_number || address.phone || address.mobile || ""
  ).trim();

  const countryCode = String(
    address.country_code || client.country_code || order.country_code || ""
  ).trim();

  return { accountPhone, deliveryPhone, countryCode };
}

function formatPhoneLine(label, phone, countryCode) {
  if (!phone) return `<div><b>${label}:</b> -</div>`;
  const cc = countryCode ? `+${countryCode.replace(/\D/g, "")} ` : "";
  const display = `${cc}${phone}`;
  return `<div><b>${label}:</b> <a href="tel:${display.replace(/\s/g, "")}">${escapeHtml(display)}</a></div>`;
}

function renderBill(billData) {
  if (!billData) return;

  const currency = billData.display_currency || "USD";
  const statusClass = billData.supplier_paid ? "status-paid" : "status-unpaid";
  const statusText = billData.supplier_paid ? "PAID" : "UNPAID";

  const lineRows = (billData.lines || [])
    .map(
      (l) => `
    <tr>
      <td>${escapeHtml(l.item_name)}</td>
      <td>${escapeHtml(l.barcode)}</td>
      <td>${escapeHtml(l.brand || "")}</td>
      <td class="num">${l.quantity}</td>
      <td class="num">${formatAmount(l.unit_cost_display, currency)}</td>
      <td class="num">${formatAmount(l.line_cost_display, currency)}</td>
    </tr>`
    )
    .join("");

  document.getElementById("billContent").innerHTML = `
    <div class="bill-header">
      <h1>Supplier Payment Bill</h1>
      <p>Amount payable to supplier for order fulfillment</p>
    </div>

    <div class="bill-meta">
      <div><b>Supplier</b></div>
      <div>${escapeHtml(billData.supplier_name)}</div>
      <div><b>Supplier Phone</b></div>
      <div>${escapeHtml(billData.supplier_phone || "-")}</div>
      <div><b>Order Code</b></div>
      <div>${escapeHtml(billData.order_code)}</div>
      <div><b>Order Date</b></div>
      <div>${escapeHtml(billData.order_date || "-")}</div>
      <div><b>Status</b></div>
      <div class="${statusClass}">${statusText}</div>
    </div>

    <table class="bill-table">
      <thead>
        <tr>
          <th>Item</th>
          <th>Barcode</th>
          <th>Brand</th>
          <th class="num">Qty</th>
          <th class="num">Unit Cost</th>
          <th class="num">Line Cost</th>
        </tr>
      </thead>
      <tbody>
        ${lineRows || '<tr><td colspan="6" style="text-align:center;padding:16px;">No line items — total based on order supplier cost</td></tr>'}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="5" class="num">TOTAL DUE TO SUPPLIER</td>
          <td class="num">${formatAmount(billData.total_cost_display, currency)}</td>
        </tr>
      </tfoot>
    </table>

    <div class="bill-footer">
      Generated on ${new Date().toLocaleString()} — Please verify quantities and amounts before payment.
    </div>
  `;
}

function openBillModal() {
  if (!currentBillData) {
    alert("Bill data is not available for this order.");
    return;
  }
  renderBill(currentBillData);
  document.getElementById("billBackdrop").classList.add("open");
  document.getElementById("billModal").classList.add("open");
}

function closeBillModal() {
  document.getElementById("billBackdrop").classList.remove("open");
  document.getElementById("billModal").classList.remove("open");
}

document.getElementById("btnViewBill").addEventListener("click", openBillModal);
document.getElementById("btnCloseBill").addEventListener("click", closeBillModal);
document.getElementById("billBackdrop").addEventListener("click", closeBillModal);

document.getElementById("btnPrintBill").addEventListener("click", () => {
  window.print();
});

document.getElementById("btnCopyBill").addEventListener("click", async () => {
  if (!currentBillData) return;
  const text = billExport.buildBillPlainText(currentBillData);
  try {
    await navigator.clipboard.writeText(text);
    alert("Bill copied to clipboard. Paste it in WhatsApp.");
  } catch {
    prompt("Copy this bill text:", text);
  }
});

document.getElementById("btnWhatsAppBill").addEventListener("click", async () => {
  if (!currentBillData) return;
  const res = await ipcRenderer.invoke("bill:openWhatsApp", currentBillData);
  if (!res?.ok) {
    alert(res?.error || "Could not open WhatsApp");
  }
});

document.getElementById("btnExportExcel").addEventListener("click", async () => {
  if (!currentBillData) return;
  const res = await ipcRenderer.invoke("bill:exportExcel", currentBillData);
  if (res?.canceled) return;
  if (!res?.ok) {
    alert(res?.error || "Export failed");
    return;
  }
  alert(`Bill saved to:\n${res.path}`);
});

document.getElementById("btnExportWord").addEventListener("click", async () => {
  if (!currentBillData) return;
  const res = await ipcRenderer.invoke("bill:exportWord", currentBillData);
  if (res?.canceled) return;
  if (!res?.ok) {
    alert(res?.error || "Export failed");
    return;
  }
  alert(`Bill saved to:\n${res.path}\n\nOpen in Microsoft Word to print.`);
});

ipcRenderer.on("order-data", (_, payload) => {
  const order = payload?.order || payload;
  currentBillData = payload?.billData || null;

  if (!order) return;

  document.getElementById("orderTitle").innerText =
    `Order ${order.code} — ${order.status}`;

  const customer = order.client || order.customer || {};
  const address = order.address || {};
  const opCity = order.op_city || {};
  const phones = getCustomerPhones(order);

  document.getElementById("customerInfo").innerHTML = `
    <div><b>Name:</b> ${escapeHtml(customer.first_name || "")} ${escapeHtml(customer.last_name || "")}</div>
    ${formatPhoneLine("Customer Phone", phones.accountPhone, phones.countryCode)}
    ${formatPhoneLine("Delivery Phone", phones.deliveryPhone, phones.countryCode)}
    <div><b>Email:</b> ${escapeHtml(customer.email || "-")}</div>
    <div><b>Segment:</b> ${escapeHtml(customer.activity_segment || "-")}</div>
    <div><b>Value Segment:</b> ${escapeHtml(customer.value_segment || "-")}</div>
    <hr/>
    <div><b>City:</b> ${escapeHtml(opCity.ref || "-")}</div>
    <div><b>Country:</b> ${escapeHtml(opCity.country || "-")}</div>
    <div><b>Country Code:</b> ${escapeHtml(phones.countryCode || "-")}</div>
  `;

  const a = order.address || {};
  const addrText = [
    a.nickname && `(${a.nickname})`,
    a.street,
    a.apartment,
    a.building_ref && `Bldg: ${a.building_ref}`,
    a.instructions && `Notes: ${a.instructions}`,
  ]
    .filter(Boolean)
    .join(" • ");

  document.getElementById("address").textContent = addrText || "-";

  const mapsLink = a.lat && a.lon ? `https://www.google.com/maps?q=${a.lat},${a.lon}` : null;
  document.getElementById("maps").innerHTML = mapsLink
    ? `<a href="${mapsLink}">Open in Maps</a>`
    : "";

  const supplierLine = currentBillData
    ? `<div><b>Supplier:</b> ${escapeHtml(currentBillData.supplier_name)}</div>
       <div><b>Supplier Phone:</b> ${escapeHtml(currentBillData.supplier_phone || "-")}</div>
       <div><b>Supplier Cost:</b> ${formatAmount(currentBillData.total_cost_display, currentBillData.display_currency)}</div>
       <div><b>Supplier Paid:</b> ${currentBillData.supplier_paid ? "Yes" : "No"}</div>`
    : "";

  document.getElementById("orderSummary").innerHTML = `
    <div><b>Total:</b> ${order.total}</div>
    <div><b>Items Total:</b> ${order.items_total}</div>
    <div><b>Delivery:</b> ${order.delivery_charge}</div>
    <div><b>Tip:</b> ${order.tip}</div>
    <div><b>Payment:</b> ${order.payment_type}</div>
    <div><b>Created:</b> ${order.created_at}</div>
    ${supplierLine}
  `;

  const container = document.getElementById("itemsContainer");
  container.innerHTML = "";

  const items = order.order_detail || [];

  items.forEach((detail) => {
    const item = detail.item || {};
    const div = document.createElement("div");
    div.className = "item-card";

    const image =
      item.image || (item.imgs && item.imgs[0]) || "https://via.placeholder.com/150";

    div.innerHTML = `
      <img src="${escapeHtml(image)}" alt="" />
      <div class="value">${escapeHtml(item.ref || "-")}</div>
      <div class="label">Barcode: ${escapeHtml(item.barcode || "-")}</div>
      <div class="label">Qty: ${detail.quantity}</div>
      <div class="label">Unit Price: ${detail.item_price}</div>
      <div class="label">Total: ${detail.total}</div>
    `;

    container.appendChild(div);
  });
});
