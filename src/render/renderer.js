const $ = (id) => document.getElementById(id);

const err = $("err");
const stats = $("stats");
const statusEl = $("status");
const tbody = $("tbody");

const chkSettlements = $("chkSettlements");
const selCurrencyDisplay = $("selCurrencyDisplay");

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

function renderRows(rows) {
  tbody.innerHTML = "";

  for (const r of rows) {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>
  <button class="view-btn" data-code="${r.order_code}">
    View
  </button></td>
      <td>${r.order_code}</td>
      <td class="num">${fmt(r.gross)}</td>
      <td class="num">${fmt(r.service_fee)}</td>
      <td class="num">${fmt(r.vat)}</td>
      <td class="num">${fmt(r.incentive)}</td>
      <td class="num">${fmt(r.merchant_payout)}</td>
      <td class="num">${fmt(r.toters_margin)}</td>
      <td class="num">
        <input class="inp" data-order="${r.order_code}" data-kind="cost" value="${r.supplier_cost || 0}" />
      </td>
      <td>
        <input type="checkbox" data-order="${r.order_code}" data-kind="paid" ${r.supplier_paid ? "checked" : ""} />
      </td>
      <td class="num">${fmt(r.net_profit)}</td>
      <td class="num">${r.row_count}</td>
      <td>${r.dates || ""}</td>
    `;

    tbody.appendChild(tr);
  }

  document.getElementById("btnProducts").addEventListener("click", () => {
    window.api.openProducts();
  });

  document.getElementById("btnRevenueDashboard").addEventListener("click", () => {
    window.api.openRevenueDashboard();
  });

  document.querySelectorAll(".view-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const code = btn.getAttribute("data-code");
    window.api.openOrder(code);
  });
});

  // wire inputs
  tbody.querySelectorAll("input[data-kind='cost']").forEach((inp) => {
    inp.addEventListener("change", async (e) => {
      const order_code = e.target.getAttribute("data-order");
      const supplier_cost = Number(e.target.value || 0);
      const paidEl = tbody.querySelector(`input[data-kind='paid'][data-order='${order_code}']`);
      const supplier_paid = paidEl ? paidEl.checked : false;

      await window.api.ordersUpsertMeta({ order_code, supplier_cost, supplier_paid });
      await refresh();
    });
  });

  tbody.querySelectorAll("input[data-kind='paid']").forEach((inp) => {
    inp.addEventListener("change", async (e) => {
      const order_code = e.target.getAttribute("data-order");
      const paid = e.target.checked;
      const costEl = tbody.querySelector(`input[data-kind='cost'][data-order='${order_code}']`);
      const supplier_cost = costEl ? Number(costEl.value || 0) : 0;

      await window.api.ordersUpsertMeta({ order_code, supplier_cost, supplier_paid: paid });
      await refresh();
    });
  });
}

async function refresh() {
  setError("");
  const includeSettlements = chkSettlements.checked;
  const [rows, totals] = await Promise.all([
    window.api.ordersGetReconciliation(),
    window.api.totalsGet({ includeSettlements })
  ]);

  renderRows(rows);
  setStats(totals);
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

$("btnGenerateSales").addEventListener("click", async () => {
  try {
    const from = salesFrom.value || null;
    const to = salesTo.value || null;
    const rows = await window.api.salesReport({ from, to });
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
    const res = await window.api.salesExportExcel({ from, to });
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
    alert(`Synced sales from orders. Processed orders: ${res.processed}`);
  } catch (e) {
    $("btnSyncSales").disabled = false;
    statusEl.textContent = "";
    setError(e);
  }
});

// Initial load
loadWalletConfig().then(() => {
  refresh().catch(setError);
});
