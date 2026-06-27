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

function getBillCurrency() {
  return currentBillData?.display_currency || "USD";
}

function getCostInputStep(currency) {
  return currency === "USD" ? "0.01" : "1";
}

function roundDisplayAmount(value, currency) {
  const n = Number(value) || 0;
  if (currency === "LBP") return Math.round(n);
  return Math.round(n * 100) / 100;
}

function recalcBillTotals(lines, currency, usdToLbpRate) {
  const totalDisplay = roundDisplayAmount(
    (lines || []).reduce((sum, l) => sum + Number(l.line_cost_display || 0), 0),
    currency
  );
  const totalUsd =
    currency === "LBP"
      ? totalDisplay / Number(usdToLbpRate || 90000)
      : totalDisplay;
  return { totalDisplay, totalUsd };
}

function syncBillEdits() {
  if (!currentBillData) return null;

  const currency = getBillCurrency();
  const rate = Number(currentBillData.usd_to_lbp_rate || 90000);
  const tbody = document.querySelector("#billContent .bill-table tbody");
  if (!tbody) return currentBillData;

  const lines = currentBillData.lines || [];

  tbody.querySelectorAll("tr[data-line-index]").forEach((tr) => {
    const idx = Number(tr.getAttribute("data-line-index"));
    if (!Number.isFinite(idx) || !lines[idx]) return;

    const line = lines[idx];
    const qty = Number(line.quantity || 0);
    const unitInp = tr.querySelector("[data-bill-unit]");
    const lineInp = tr.querySelector("[data-bill-line]");

    const unitDisplay = roundDisplayAmount(unitInp?.value, currency);
    const lineDisplay = roundDisplayAmount(lineInp?.value, currency);

    line.unit_cost_display = unitDisplay;
    line.line_cost_display = lineDisplay;

    if (currency === "LBP") {
      line.unit_cost_usd = unitDisplay / rate;
      line.line_cost_usd = lineDisplay / rate;
    } else {
      line.unit_cost_usd = unitDisplay;
      line.line_cost_usd = lineDisplay;
    }
  });

  const { totalDisplay, totalUsd } = recalcBillTotals(lines, currency, rate);
  currentBillData.lines = lines;
  currentBillData.total_cost_display = totalDisplay;
  currentBillData.total_cost_usd = totalUsd;

  const totalEl = document.getElementById("billTotalDue");
  if (totalEl) totalEl.textContent = formatAmount(totalDisplay, currency);

  return currentBillData;
}

function getBillDataForAction() {
  return syncBillEdits() || currentBillData;
}

function wireBillCostInputs() {
  const currency = getBillCurrency();
  const tbody = document.querySelector("#billContent .bill-table tbody");
  if (!tbody) return;

  tbody.querySelectorAll("[data-bill-unit]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const tr = inp.closest("tr");
      const idx = Number(tr?.getAttribute("data-line-index"));
      const line = currentBillData?.lines?.[idx];
      if (!line) return;

      const qty = Number(line.quantity || 0);
      const unit = roundDisplayAmount(inp.value, currency);
      const lineInp = tr.querySelector("[data-bill-line]");
      if (lineInp && qty > 0) {
        lineInp.value = String(roundDisplayAmount(unit * qty, currency));
      }
      syncBillEdits();
    });
  });

  tbody.querySelectorAll("[data-bill-line]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const tr = inp.closest("tr");
      const idx = Number(tr?.getAttribute("data-line-index"));
      const line = currentBillData?.lines?.[idx];
      if (!line) return;

      const qty = Number(line.quantity || 0);
      const lineCost = roundDisplayAmount(inp.value, currency);
      const unitInp = tr.querySelector("[data-bill-unit]");
      if (unitInp && qty > 0) {
        unitInp.value = String(roundDisplayAmount(lineCost / qty, currency));
      }
      syncBillEdits();
    });
  });
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

function renderBill(billData, opts = {}) {
  if (!billData) return;

  const editable = opts.editable !== false;
  const currency = billData.display_currency || "USD";
  const statusClass = billData.supplier_paid ? "status-paid" : "status-unpaid";
  const statusText = billData.supplier_paid ? "PAID" : "UNPAID";
  const step = getCostInputStep(currency);
  const lines = billData.lines || [];

  const lineRows = lines
    .map((l, idx) => {
      const unitVal = roundDisplayAmount(l.unit_cost_display, currency);
      const lineVal = roundDisplayAmount(l.line_cost_display, currency);

      const unitCell = editable
        ? `<input type="number" class="bill-cost-inp" data-bill-unit min="0" step="${step}" value="${unitVal}" />`
        : formatAmount(unitVal, currency);

      const lineCell = editable
        ? `<input type="number" class="bill-cost-inp" data-bill-line min="0" step="${step}" value="${lineVal}" />`
        : formatAmount(lineVal, currency);

      return `
    <tr data-line-index="${idx}">
      <td>${escapeHtml(l.item_name)}</td>
      <td>${escapeHtml(l.barcode)}</td>
      <td>${escapeHtml(l.brand || "")}</td>
      <td class="num">${l.quantity}</td>
      <td class="num">${unitCell}</td>
      <td class="num">${lineCell}</td>
    </tr>`;
    })
    .join("");

  const editHint = editable && lines.length
    ? `<p class="bill-edit-hint">You can edit Unit Cost and Line Cost below before printing or sending.</p>`
    : "";

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

    ${editHint}

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
          <td class="num" id="billTotalDue">${formatAmount(billData.total_cost_display, currency)}</td>
        </tr>
      </tfoot>
    </table>

    <div class="bill-footer">
      Generated on ${new Date().toLocaleString()} — Please verify quantities and amounts before payment.
    </div>
  `;

  if (editable) wireBillCostInputs();
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
  syncBillEdits();
  document.getElementById("billBackdrop").classList.remove("open");
  document.getElementById("billModal").classList.remove("open");
}

document.getElementById("btnViewBill").addEventListener("click", openBillModal);
document.getElementById("btnCloseBill").addEventListener("click", closeBillModal);
document.getElementById("billBackdrop").addEventListener("click", closeBillModal);

document.getElementById("btnPrintBill").addEventListener("click", () => {
  const data = getBillDataForAction();
  if (!data) return;
  renderBill(data, { editable: false });
  window.print();
  renderBill(data, { editable: true });
});

document.getElementById("btnCopyBill").addEventListener("click", async () => {
  const data = getBillDataForAction();
  if (!data) return;
  const text = billExport.buildBillPlainText(data);
  try {
    await navigator.clipboard.writeText(text);
    alert("Bill copied to clipboard. Paste it in WhatsApp.");
  } catch {
    prompt("Copy this bill text:", text);
  }
});

document.getElementById("btnWhatsAppBill").addEventListener("click", async () => {
  const data = getBillDataForAction();
  if (!data) return;
  const res = await ipcRenderer.invoke("bill:openWhatsApp", data);
  if (!res?.ok) {
    alert(res?.error || "Could not open WhatsApp");
  }
});

document.getElementById("btnExportExcel").addEventListener("click", async () => {
  const data = getBillDataForAction();
  if (!data) return;
  const res = await ipcRenderer.invoke("bill:exportExcel", data);
  if (res?.canceled) return;
  if (!res?.ok) {
    alert(res?.error || "Export failed");
    return;
  }
  alert(`Bill saved to:\n${res.path}`);
});

document.getElementById("btnExportWord").addEventListener("click", async () => {
  const data = getBillDataForAction();
  if (!data) return;
  const res = await ipcRenderer.invoke("bill:exportWord", data);
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
    <div><b>Total:</b> ${Number(order.final_total || order.total || 0).toLocaleString()}</div>
    <div><b>Items Total:</b> ${Number(order.final_cost || order.items_total || 0).toLocaleString()}</div>
    <div><b>Delivery:</b> ${order.delivery_charge ?? "-"}</div>
    <div><b>Tip:</b> ${order.tip}</div>
    <div><b>Payment:</b> ${order.payment_type}</div>
    <div><b>Created:</b> ${order.created_at}</div>
    ${supplierLine}
  `;

  const container = document.getElementById("itemsContainer");
  container.innerHTML = "";

  const items = order.order_detail || [];
  const adjustedCount = items.filter((d) => d.was_adjusted).length;

  if (adjustedCount > 0) {
    const note = document.createElement("div");
    note.className = "adjustment-note";
    note.style.marginBottom = "12px";
    note.textContent = `${adjustedCount} item(s) adjusted — quantities and totals reflect final values after shopper changes.`;
    container.appendChild(note);
  }

  items.forEach((detail) => {
    const item = detail.item || {};
    const div = document.createElement("div");
    div.className = detail.was_adjusted ? "item-card adjusted" : "item-card";

    const image =
      item.image || (item.imgs && item.imgs[0]) || "https://via.placeholder.com/150";

    const qtyLine = detail.was_adjusted
      ? `<div class="label">Qty: <s>${detail.ordered_quantity}</s> → <b>${detail.quantity}</b></div>`
      : `<div class="label">Qty: ${detail.quantity}</div>`;

    const totalLine = detail.was_adjusted
      ? `<div class="label">Total: <s>${detail.ordered_total?.toLocaleString()}</s> → <b>${Number(detail.total || 0).toLocaleString()}</b></div>`
      : `<div class="label">Total: ${Number(detail.total || 0).toLocaleString()}</div>`;

    const badge = detail.was_adjusted
      ? `<div class="adjustment-badge">Adjusted</div>`
      : "";

    div.innerHTML = `
      ${badge}
      <img src="${escapeHtml(image)}" alt="" />
      <div class="value">${escapeHtml(item.ref || detail.item_ref || "-")}</div>
      <div class="label">Barcode: ${escapeHtml(item.barcode || "-")}</div>
      ${qtyLine}
      <div class="label">Unit Price: ${Number(detail.item_price || 0).toLocaleString()}</div>
      ${totalLine}
    `;

    container.appendChild(div);
  });
});
