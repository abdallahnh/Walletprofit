const $ = (id) => document.getElementById(id);

const txt = $("txt");
const err = $("err");
const stats = $("stats");
const tbody = $("tbody");

const chkSettlements = $("chkSettlements");

// Wallet modal elements
const walletBackdrop = $("walletModalBackdrop");
const walletModal = $("walletModal");
const inpBaseUrl = $("inpBaseUrl");
const inpStoreId = $("inpStoreId");
const inpWallet = $("inpWallet");
const inpToken = $("inpToken");
const walletMsg = $("walletModalMsg");

function fmt(n) {
  const x = Number(n) || 0;
  return x.toLocaleString();
}

function setError(e) {
  err.textContent = e ? String(e) : "";
}

function setStats(t) {
  const includeSettlements = chkSettlements.checked;

  const blocks = [
    [`Orders`, fmt(t.orders)],
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
      <td class="num">${fmt(r.row_count)}</td>
      <td>${r.dates || ""}</td>
    `;

    tbody.appendChild(tr);
  }

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

function openWalletModal(cfg) {
  walletMsg.textContent = "";
  inpBaseUrl.value = cfg?.baseUrl || "https://dashboard.toters-api.com";
  inpStoreId.value = cfg?.storeId || "";
  inpWallet.value = cfg?.wallet || "main";
  inpToken.value = cfg?.token || "";
  walletBackdrop.classList.remove("hidden");
  walletModal.classList.remove("hidden");
}

function closeWalletModal() {
  walletBackdrop.classList.add("hidden");
  walletModal.classList.add("hidden");
}

async function loadWalletConfigAndOpen() {
  const cfg = await window.api.walletGetConfig();
  openWalletModal(cfg);
}

// Buttons
$("btnImport").addEventListener("click", async () => {
  try {
    setError("");
    const res = await window.api.importMerge(txt.value);
    await refresh();
    alert(`Imported. Inserted: ${res.inserted} | Duplicates ignored: ${res.ignored}`);
  } catch (e) {
    setError(e);
  }
});

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

$("btnExportBackup").addEventListener("click", async () => {
  try {
    const p = await window.api.exportBackup();
    alert(`Backup exported to: ${p}`);
  } catch (e) {
    setError(e);
  }
});

$("btnImportBackup").addEventListener("click", async () => {
  try {
    const res = await window.api.importBackup();
    if (!res?.canceled) {
      alert(`Imported backup. Transactions: ${res.imported_transactions} | Meta: ${res.imported_meta}`);
      await refresh();
    }
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
    const res = await window.api.walletSync();
    if (!res.ok) {
      setError(res.error || "Sync failed");
      return;
    }
    await refresh();
    alert(`Synced. Fetched: ${res.totalFetched} | Inserted: ${res.totalInserted} | Duplicates ignored: ${res.totalIgnored} | Pages: ${res.pages}`);
  } catch (e) {
    setError(e);
  }
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
      token: inpToken.value.trim()
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

// Initial load
refresh().catch(setError);
