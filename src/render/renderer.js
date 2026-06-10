const $ = (id) => document.getElementById(id);

const err = $("err");
const stats = $("stats");
const statusEl = $("status");
const tbody = $("tbody");

const chkSettlements = $("chkSettlements");
const selCurrencyDisplay = $("selCurrencyDisplay");
const selPaidFilter = $("selPaidFilter");
const selTypeFilter = $("selTypeFilter");
const btnColumns = $("btnColumns");
const columnsPanel = $("columnsPanel");

const salesFrom = $("salesFrom");
const salesTo = $("salesTo");

// Wallet modal elements
const walletBackdrop = $("walletModalBackdrop");
const walletModal = $("walletModal");
const inpBaseUrl = $("inpBaseUrl");
const inpStoreId = $("inpStoreId");
const inpWallet = $("inpWallet");
const inpToken = $("inpToken");
const inpUsdToLbpRate = $("inpUsdToLbpRate");
const selDisplayCurrency = $("selDisplayCurrency");
const walletMsg = $("walletModalMsg");

let currentCurrency = "USD";
let usdToLbpRate = 90000;
let allRowsCache = [];
let currentRowsView = [];
let supplierListCache = [];
let tableSortKey = null;
let tableSortDir = "asc";
let summarySortKey = "supplier_name";
let summarySortDir = "asc";
let supplierFilter = null;

const COLUMN_DEFS = [
  { key: "view", label: "View" },
  { key: "order", label: "Order" },
  { key: "supplier", label: "Supplier" },
  { key: "gross", label: "Gross" },
  { key: "service", label: "Service" },
  { key: "vat", label: "VAT" },
  { key: "incentive", label: "Incentive" },
  { key: "merchant_payout", label: "Merchant Payout" },
  { key: "toters_margin", label: "Toters Margin" },
  { key: "supplier_cost", label: "Supplier Cost" },
  { key: "paid", label: "Paid" },
  { key: "net_profit", label: "Net Profit" },
  { key: "rows", label: "Rows" },
  { key: "dates", label: "Dates" },
];

function getVisibleColumns() {
  try {
    const raw = localStorage.getItem("wallet-columns-visible");
    if (!raw) return COLUMN_DEFS.map((c) => c.key);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return COLUMN_DEFS.map((c) => c.key);
    return parsed;
  } catch {
    return COLUMN_DEFS.map((c) => c.key);
  }
}

function saveVisibleColumns(keys) {
  localStorage.setItem("wallet-columns-visible", JSON.stringify(keys));
}

function applyColumnVisibility() {
  const visible = new Set(getVisibleColumns());
  document.querySelectorAll("th[data-col], td[data-col]").forEach((el) => {
    const key = el.getAttribute("data-col");
    el.style.display = visible.has(key) ? "" : "none";
  });
}

function renderColumnsPanel() {
  const visible = new Set(getVisibleColumns());
  columnsPanel.innerHTML = COLUMN_DEFS.map((col) => `
    <label>
      <input type="checkbox" data-col-check="${col.key}" ${visible.has(col.key) ? "checked" : ""} />
      ${col.label}
    </label>
  `).join("");

  columnsPanel.querySelectorAll("input[data-col-check]").forEach((chk) => {
    chk.addEventListener("change", () => {
      const next = Array.from(columnsPanel.querySelectorAll("input[data-col-check]"))
        .filter((x) => x.checked)
        .map((x) => x.getAttribute("data-col-check"));
      if (!next.length) {
        chk.checked = true;
        return;
      }
      saveVisibleColumns(next);
      applyColumnVisibility();
    });
  });
}

function fmt(n, currency = currentCurrency) {
  const x = Number(n) || 0;

  if (currency === "USD") {
    // Convert from LBP to USD
    const usdAmount = x / usdToLbpRate;
    return usdAmount.toLocaleString();
  } else {
    // Show in LBP
    return x.toLocaleString() + " L.L";
  }
}

function supplierCostLbpToDisplay(costLbp) {
  const value = Number(costLbp || 0);
  if (currentCurrency === "USD") {
    return (value / usdToLbpRate).toFixed(2);
  }
  return String(Math.round(value));
}

function supplierCostDisplayToLbp(displayValue) {
  const raw = Number(displayValue || 0);
  if (!Number.isFinite(raw)) return 0;
  if (currentCurrency === "USD") {
    return Math.round(raw * usdToLbpRate);
  }
  return Math.round(raw);
}

function setError(e) {
  err.textContent = e ? String(e) : "";
}

function setStats(t) {
  const includeSettlements = chkSettlements.checked;

  const blocks = [
    [`Orders`, t.orders],
    [`Gross`, fmt(t.gross)],
    [`Service`, fmt(t.service_fee)],
    [`VAT`, fmt(t.vat)],
    [`Incentive`, fmt(t.incentive)],
    [`Merchant Payout`, fmt(t.merchantPayout)],
    [`Toters Margin`, fmt(t.totersMargin)],
    [`Supplier Cost`, fmt(t.supplierCost)],
    [`Net Profit`, fmt(t.netProfit)],
  ];

  if (includeSettlements) {
    blocks.push([`Balance Settlements`, fmt(t.settlements)]);
    blocks.push([`Net Profit + Settlements`, fmt(t.netProfitWithSettlements)]);
  }

  stats.innerHTML = blocks
    .map(([k, v]) => `<div class="stat">${k}: <b>${v}</b></div>`)
    .join("");
}

function calculateTotalsFromRows(rows, includeSettlements) {
  const totals = {
    orders: rows.length,
    gross: 0,
    service_fee: 0,
    vat: 0,
    incentive: 0,
    merchantPayout: 0,
    totersMargin: 0,
    supplierCost: 0,
    netProfit: 0,
    settlements: 0,
    netProfitWithSettlements: includeSettlements ? 0 : null,
  };

  for (const r of rows) {
    totals.gross += Number(r.gross || 0);
    totals.service_fee += Number(r.service_fee || 0);
    totals.vat += Number(r.vat || 0);
    totals.incentive += Number(r.incentive || 0);
    totals.merchantPayout += Number(r.merchant_payout || 0);
    totals.totersMargin += Number(r.toters_margin || 0);
    totals.supplierCost += Number(r.supplier_cost || 0);
    totals.netProfit += Number(r.net_profit || 0);
  }

  if (includeSettlements) {
    totals.netProfitWithSettlements = totals.netProfit + totals.settlements;
  }
  return totals;
}

function getSelectedSupplierIds() {
  return supplierFilter ? supplierFilter.getSelectedIds() : null;
}

function getFilteredRows(rows) {
  const paidFilter = selPaidFilter.value || "all";
  const typeFilter = selTypeFilter?.value || "all";
  const supplierIds = getSelectedSupplierIds();

  return rows.filter((r) => {
    if (supplierIds && supplierIds.length > 0) {
      if (!r.supplier_id || !supplierIds.includes(r.supplier_id)) return false;
    }

    if (paidFilter === "paid" && !r.supplier_paid) return false;
    if (paidFilter === "unpaid" && r.supplier_paid) return false;

    if (typeFilter === "all") return true;
    if (typeFilter === "missing") return !!r.has_missing_types;

    const presentTypes = String(r.transaction_types || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    return presentTypes.includes(typeFilter);
  });
}

function sortRows(rows, key, dir) {
  if (!key) return rows;
  const sorted = [...rows];
  const mult = dir === "desc" ? -1 : 1;

  sorted.sort((a, b) => {
    let av = a[key];
    let bv = b[key];

    if (key === "supplier_name") {
      av = String(av || "").toLowerCase();
      bv = String(bv || "").toLowerCase();
      return av.localeCompare(bv) * mult;
    }

    av = Number(av || 0);
    bv = Number(bv || 0);
    return (av - bv) * mult;
  });

  return sorted;
}

function applyTableSort(rows) {
  return sortRows(rows, tableSortKey, tableSortDir);
}

async function loadSupplierList() {
  try {
    supplierListCache = await window.api.suppliersGetAll();
    if (supplierFilter) supplierFilter.reload();
  } catch (e) {
    console.error("Failed to load suppliers:", e);
  }
}

function renderSupplierSummary(rows) {
  const tbody = $("supplierSummaryBody");
  if (!tbody) return;

  const bySupplier = new Map();

  for (const o of rows) {
    const key = o.supplier_id || 0;
    const name = o.supplier_name || "(Unassigned)";

    if (!bySupplier.has(key)) {
      bySupplier.set(key, {
        supplier_name: name,
        orders: 0,
        revenue: 0,
        supplier_cost: 0,
        payable: 0,
        profit: 0,
      });
    }

    const row = bySupplier.get(key);
    row.orders += 1;
    row.revenue += Number(o.merchant_payout || 0);
    row.supplier_cost += Number(o.supplier_cost || 0);
    if (!o.supplier_paid) row.payable += Number(o.supplier_cost || 0);
    row.profit += Number(o.net_profit || 0);
  }

  let summaryRows = Array.from(bySupplier.values());
  summaryRows = sortRows(summaryRows, summarySortKey, summarySortDir);

  tbody.innerHTML = summaryRows
    .map(
      (s) => `
    <tr>
      <td>${escapeHtml(s.supplier_name)}</td>
      <td class="num">${s.orders}</td>
      <td class="num">${fmt(s.revenue)}</td>
      <td class="num">${fmt(s.supplier_cost)}</td>
      <td class="num">${fmt(s.payable)}</td>
      <td class="num">${fmt(s.profit)}</td>
    </tr>
  `
    )
    .join("");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildSupplierSelectHtml(selectedId) {
  const options = ['<option value="">— Select —</option>'];
  for (const s of supplierListCache) {
    const sel = Number(selectedId) === Number(s.id) ? " selected" : "";
    options.push(`<option value="${s.id}"${sel}>${escapeHtml(s.name)}</option>`);
  }
  return options.join("");
}

function getSupplierIdFromRow(orderCode) {
  const el = tbody.querySelector(`select[data-kind='supplier'][data-order='${orderCode}']`);
  if (!el || !el.value) return null;
  return Number(el.value) || null;
}

function renderRows(rows) {
  tbody.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td data-col="view">
  <button class="view-btn" data-code="${r.order_code}">
    View
  </button></td>
      <td data-col="order">${r.order_code}</td>
      <td data-col="supplier">
        <select
          class="sel-supplier"
          data-order="${r.order_code}"
          data-kind="supplier"
        >${buildSupplierSelectHtml(r.supplier_id)}</select>
      </td>
      <td class="num" data-col="gross">${fmt(r.gross)}</td>
      <td class="num" data-col="service">${fmt(r.service_fee)}</td>
      <td class="num" data-col="vat">${fmt(r.vat)}</td>
      <td class="num" data-col="incentive">${fmt(r.incentive)}</td>
      <td class="num" data-col="merchant_payout">${fmt(r.merchant_payout)}</td>
      <td class="num" data-col="toters_margin">${fmt(r.toters_margin)}</td>
      <td class="num" data-col="supplier_cost">
        <input
          class="inp"
          type="number"
          step="${currentCurrency === "USD" ? "0.01" : "1"}"
          min="0"
          data-order="${r.order_code}"
          data-kind="cost"
          value="${supplierCostLbpToDisplay(r.supplier_cost)}"
        />
      </td>
      <td data-col="paid">
        <input type="checkbox" data-order="${r.order_code}" data-kind="paid" ${r.supplier_paid ? "checked" : ""} />
      </td>
      <td class="num" data-col="net_profit">${fmt(r.net_profit)}</td>
      <td class="num" data-col="rows">${r.row_count}</td>
      <td data-col="dates">${r.dates || ""}</td>
    `;

    tbody.appendChild(tr);
  }

  document.querySelectorAll(".view-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const code = btn.getAttribute("data-code");
    window.api.openOrder(code);
  });
});

  // wire inputs
  tbody.querySelectorAll("select[data-kind='supplier']").forEach((sel) => {
    sel.addEventListener("change", async (e) => {
      const order_code = e.target.getAttribute("data-order");
      const supplier_id = e.target.value ? Number(e.target.value) : null;
      const costEl = tbody.querySelector(`input[data-kind='cost'][data-order='${order_code}']`);
      const paidEl = tbody.querySelector(`input[data-kind='paid'][data-order='${order_code}']`);
      const supplier_cost = costEl ? supplierCostDisplayToLbp(costEl.value) : 0;
      const supplier_paid = paidEl ? paidEl.checked : false;

      const res = await window.api.ordersUpsertMeta({
        order_code,
        supplier_cost,
        supplier_paid,
        supplier_id,
      });
      if (res?.ok === false) {
        setError(res.error || "Failed to save supplier");
        return;
      }
      await refresh();
    });
  });

  tbody.querySelectorAll("input[data-kind='cost']").forEach((inp) => {
    inp.addEventListener("change", async (e) => {
      const order_code = e.target.getAttribute("data-order");
      const supplier_cost = supplierCostDisplayToLbp(e.target.value);
      const paidEl = tbody.querySelector(`input[data-kind='paid'][data-order='${order_code}']`);
      const supplier_paid = paidEl ? paidEl.checked : false;
      const supplier_id = getSupplierIdFromRow(order_code);

      const res = await window.api.ordersUpsertMeta({
        order_code,
        supplier_cost,
        supplier_paid,
        supplier_id,
      });
      if (res?.ok === false) {
        setError(res.error || "Failed to save supplier cost");
        return;
      }
      await refresh();
    });
  });

  tbody.querySelectorAll("input[data-kind='paid']").forEach((inp) => {
    inp.addEventListener("change", async (e) => {
      const order_code = e.target.getAttribute("data-order");
      const paid = e.target.checked;
      const costEl = tbody.querySelector(`input[data-kind='cost'][data-order='${order_code}']`);
      const supplier_cost = costEl ? supplierCostDisplayToLbp(costEl.value) : 0;
      const supplier_id = getSupplierIdFromRow(order_code);

      const res = await window.api.ordersUpsertMeta({
        order_code,
        supplier_cost,
        supplier_paid: paid,
        supplier_id,
      });
      if (res?.ok === false) {
        setError(res.error || "Failed to save paid status");
        return;
      }
      await refresh();
    });
  });

  applyColumnVisibility();
}

async function refresh() {
  setError("");
  await loadSupplierList();
  const includeSettlements = chkSettlements.checked;
  const rows = await window.api.ordersGetReconciliation();
  allRowsCache = rows;
  currentRowsView = applyTableSort(getFilteredRows(rows));
  renderRows(currentRowsView);
  setStats(calculateTotalsFromRows(currentRowsView, includeSettlements));
  renderSupplierSummary(currentRowsView);
}

async function refreshViewFromCache() {
  await loadSupplierList();
  const includeSettlements = chkSettlements.checked;
  currentRowsView = applyTableSort(getFilteredRows(allRowsCache));
  renderRows(currentRowsView);
  setStats(calculateTotalsFromRows(currentRowsView, includeSettlements));
  renderSupplierSummary(currentRowsView);
}

async function loadWalletConfig() {
  try {
    const cfg = await window.api.walletGetConfig();
    if (cfg) {
      currentCurrency = cfg.displayCurrency || "USD";
      usdToLbpRate = cfg.usdToLbpRate || 90000;
      selCurrencyDisplay.value = currentCurrency;
    }
  } catch (e) {
    console.error("Failed to load wallet config:", e);
  }
}

function closeWalletModal() {
  walletBackdrop.classList.add("hidden");
  walletModal.classList.add("hidden");
}

function openWalletModal(cfg) {
  // Populate form fields with config data
  inpBaseUrl.value = cfg?.baseUrl || "";
  inpStoreId.value = cfg?.storeId || "";
  inpWallet.value = cfg?.wallet || "main";
  inpToken.value = cfg?.token || "";
  inpUsdToLbpRate.value = cfg?.usdToLbpRate || 90000;
  selDisplayCurrency.value = cfg?.displayCurrency || "USD";

  // Clear any previous messages
  walletMsg.textContent = "";

  // Show modal
  walletBackdrop.classList.remove("hidden");
  walletModal.classList.remove("hidden");
}

async function loadWalletConfigAndOpen() {
  const cfg = await window.api.walletGetConfig();
  openWalletModal(cfg);
}

// Buttons
$("btnRefresh").addEventListener("click", async () => {
  try { await refresh(); } catch (e) { setError(e); }
});

$("btnExportCsv").addEventListener("click", async () => {
  try {
    const p = await window.api.exportCsv();
    alert(`CSV exported to: ${p}`);
  } catch (e) {
    setError(e);
  }
});

$("btnExportData").addEventListener("click", async () => {
  try {
    const res = await window.api.exportBackup();
    if (res?.canceled) return;
    if (!res?.ok) {
      setError(res?.error || "Export failed");
      return;
    }
    alert(`Data exported to:\n${res.path}`);
  } catch (e) {
    setError(e);
  }
});

$("btnImportData").addEventListener("click", async () => {
  if (
    !confirm(
      "Importing a backup will replace all existing data. Are you sure?"
    )
  ) {
    return;
  }
  try {
    const res = await window.api.importBackup();
    if (res?.canceled) return;
    if (!res?.ok) {
      setError(res?.error || "Import failed");
      return;
    }
    alert("Import successful. The application will reload now.");
    location.reload();
  } catch (e) {
    setError(e);
  }
});

$("btnResetSupplier").addEventListener("click", async () => {
  if (!confirm("Reset all supplier costs & paid flags?")) return;
  try {
    await window.api.resetSupplierMeta();
    await refresh();
  } catch (e) {
    setError(e);
  }
});

$("btnWalletSettings").addEventListener("click", async () => {
  try { await loadWalletConfigAndOpen(); } catch (e) { setError(e); }
});

$("btnWalletSync").addEventListener("click", async () => {
  try {
    setError("");
    statusEl.textContent = "Syncing wallet…";
    $("btnWalletSync").disabled = true;

    const res = await window.api.walletSync();

    $("btnWalletSync").disabled = false;
    statusEl.textContent = "";

    if (!res.ok) {
      setError(res.error || "Sync failed");
      return;
    }
    await refresh();
    alert(`Synced. Fetched: ${res.totalFetched} | Inserted: ${res.totalInserted} | Duplicates ignored: ${res.totalIgnored} | Pages: ${res.pages}`);
  } catch (e) {
    $("btnWalletSync").disabled = false;
    statusEl.textContent = "";
    setError(e);
  }
});

$("btnDbAdmin").addEventListener("click", () => {
  window.api.openDbAdmin();
});
$("btnProducts").addEventListener("click", () => {
  window.api.openProducts();
});
$("btnSuppliers").addEventListener("click", () => {
  window.api.openSuppliers();
});
$("btnRevenueDashboard").addEventListener("click", () => {
  window.api.openRevenueDashboard();
});

// Modal buttons
$("btnWalletClose").addEventListener("click", closeWalletModal);
$("btnWalletCancel").addEventListener("click", closeWalletModal);
walletBackdrop.addEventListener("click", closeWalletModal);

$("btnWalletSave").addEventListener("click", async () => {
  try {
    walletMsg.textContent = "";
    const cfg = {
      baseUrl: inpBaseUrl.value.trim(),
      storeId: inpStoreId.value.trim(),
      wallet: inpWallet.value.trim() || "main",
      token: inpToken.value.trim(),
      usdToLbpRate: Number(inpUsdToLbpRate.value) || 90000,
      displayCurrency: selDisplayCurrency.value || "USD"
    };
    await window.api.walletSaveConfig(cfg);
    walletMsg.textContent = "Saved.";
    setTimeout(closeWalletModal, 400);
  } catch (e) {
    walletMsg.textContent = `Error: ${String(e)}`;
  }
});

chkSettlements.addEventListener("change", () => {
  refresh().catch(setError);
});

selCurrencyDisplay.addEventListener("change", () => {
  currentCurrency = selCurrencyDisplay.value;
  refresh().catch(setError);
});

selPaidFilter.addEventListener("change", () => refreshViewFromCache().catch(setError));
selTypeFilter?.addEventListener("change", () => refreshViewFromCache().catch(setError));

document.querySelectorAll("th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.getAttribute("data-sort");
    if (tableSortKey === key) {
      tableSortDir = tableSortDir === "asc" ? "desc" : "asc";
    } else {
      tableSortKey = key;
      tableSortDir = "asc";
    }
    refreshViewFromCache().catch(setError);
  });
});

document.querySelectorAll("[data-summary-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.getAttribute("data-summary-sort");
    if (summarySortKey === key) {
      summarySortDir = summarySortDir === "asc" ? "desc" : "asc";
    } else {
      summarySortKey = key;
      summarySortDir = "asc";
    }
    renderSupplierSummary(currentRowsView);
  });
});

btnColumns.addEventListener("click", () => {
  columnsPanel.classList.toggle("open");
});

document.addEventListener("click", (e) => {
  if (!columnsPanel.classList.contains("open")) return;
  if (columnsPanel.contains(e.target) || e.target === btnColumns) return;
  columnsPanel.classList.remove("open");
});

$("btnGenerateSales").addEventListener("click", async () => {
  try {
    const from = salesFrom.value || null;
    const to = salesTo.value || null;
    const supplierIds = getSelectedSupplierIds();
    const rows = await window.api.salesReport({ from, to, supplierIds });
    const totalProfit = rows.reduce((sum, r) => sum + (Number(r.profit || 0)), 0);
    alert(`Products: ${rows.length}\nTotal profit (USD): ${totalProfit.toFixed(2)}`);
  } catch (e) {
    setError(e);
  }
});

$("btnExportSalesExcel").addEventListener("click", async () => {
  try {
    const from = salesFrom.value || null;
    const to = salesTo.value || null;
    const supplierIds = getSelectedSupplierIds();
    const res = await window.api.salesExportExcel({ from, to, supplierIds });
    if (res && res.ok) {
      alert(`Sales report exported to: ${res.path}`);
    } else if (!res?.canceled) {
      setError(res?.error || "Export failed");
    }
  } catch (e) {
    setError(e);
  }
});

$("btnSyncSales").addEventListener("click", async () => {
  try {
    setError("");
    statusEl.textContent = "Syncing sales from orders…";
    $("btnSyncSales").disabled = true;

    const res = await window.api.salesSyncFromOrders();

    $("btnSyncSales").disabled = false;
    statusEl.textContent = "";

    if (!res?.ok) {
      setError(res?.error || "Sync sales failed");
      return;
    }
    alert(
      `Synced sales from orders.\n` +
      `Fetched: ${res.fetched || 0}\n` +
      `Skipped invalid summaries: ${res.skippedInvalidSummaries || 0}\n` +
      `Processed: ${res.processed || 0}\n` +
      `Details loaded: ${res.detailsLoaded || 0}\n` +
      `Details missing: ${res.detailsMissing || 0}\n` +
      `Details failed: ${res.detailsFailed || 0}\n` +
      `Orders with matched items: ${res.ordersWithMatchedItems || 0}\n` +
      `Orders without matched items: ${res.ordersWithoutMatchedItems || 0}\n` +
      `Total items: ${res.totalOrderItems || 0}\n` +
      `Matched items: ${res.matchedOrderItems || 0}\n` +
      `Skipped (no barcode): ${res.skippedNoBarcodeItems || 0}\n` +
      `Skipped (unmatched product): ${res.skippedUnmatchedProductItems || 0}`
    );
  } catch (e) {
    $("btnSyncSales").disabled = false;
    statusEl.textContent = "";
    setError(e);
  }
});

// Initial load
loadWalletConfig().then(() => {
  supplierFilter = createSupplierFilter($("supplierFilterContainer"), {
    onChange: () => refreshViewFromCache().catch(setError),
  });
  renderColumnsPanel();
  applyColumnVisibility();
  refresh().catch(setError);
});
