// src/main/main.js
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("path");
const XLSX = require("xlsx");

const database = require("../db/database");
const walletDb = require("../db/wallet");
const ordersDb = require("../db/orders");
const productsDb = require("../db/products");
const productCatalogCache = require("../db/productCatalogCache");
const salesDb = require("../db/sales");
const adminDb = require("../db/admin");
const suppliersDb = require("../db/suppliers");
const billExport = require("../db/billExport");
const transactionsDb = require("../db/transactions");
const companyExpensesDb = require("../db/companyExpenses");
const orderSyncState = require("../db/orderSyncState");
const walletSyncState = require("../db/walletSyncState");

const logger = require("../utils/logger");

const { syncOrders, loadDetailsByCode } = require("../services/orderService");
const { runCheckpointedOrderSync } = require("../services/salesOrderSync");
const { setAuthToken, setBaseUrl } = require("../services/totersApi");
const { createSupabaseCloud } = require("../services/supabaseCloud");
const { createProductCatalogService } = require("../services/productCatalogService");

let cloud;
let productCatalog;

function cloudStatePath() {
  return path.join(app.getPath("userData"), "cloud-session.bin");
}

function loadCloudState() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(cloudStatePath())) return {};
    const encrypted = fs.readFileSync(cloudStatePath());
    return JSON.parse(safeStorage.decryptString(encrypted));
  } catch (error) {
    logger.error("Could not restore cloud session", { error: String(error) });
    return {};
  }
}

function saveCloudState(state) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const encrypted = safeStorage.encryptString(JSON.stringify(state));
    fs.writeFileSync(cloudStatePath(), encrypted, { mode: 0o600 });
  } catch (error) {
    logger.error("Could not save cloud session", { error: String(error) });
  }
}

function initializeCloud() {
  cloud = createSupabaseCloud({
    initialState: loadCloudState(),
    onStateChange: saveCloudState,
  });
  productCatalog = createProductCatalogService({ cloud });
}

async function getCloudStatus({ checkRemote = true } = {}) {
  const local = cloud.getPublicState();
  if (!local.signed_in || !checkRemote) return { ok: true, ...local };
  try {
    const remote = await cloud.getRemoteSnapshot();
    return {
      ok: true,
      ...cloud.getPublicState(),
      remote_revision: Number(remote?.revision || 0),
      remote_updated_at: remote?.updated_at || null,
      cloud_empty: !remote,
    };
  } catch (error) {
    return { ok: false, ...cloud.getPublicState(), error: String(error.message || error) };
  }
}

async function pullCloudSnapshot() {
  const remote = await cloud.getRemoteSnapshot();
  if (!remote?.data) throw new Error("There is no cloud data to download yet.");
  const safetyBackup = path.join(
    path.dirname(database.getDbPath()),
    `wallet-profit-before-cloud-${Date.now()}.db`
  );
  await walletDb.exportSqliteBackup(safetyBackup);
  const imported = walletDb.importBackupData(remote.data, { replace: true });
  if (!imported?.ok) throw new Error(imported?.error || "Could not import cloud data");
  cloud.markPulled(remote);
  return {
    ok: true,
    action: "downloaded",
    revision: Number(remote.revision),
    imported,
    safety_backup: safetyBackup,
  };
}

async function syncCloudSnapshot() {
  const localData = walletDb.collectBackupData();
  const localHash = cloud.snapshotHash(localData);
  const state = cloud.getPublicState();
  const remote = await cloud.getRemoteSnapshot();

  if (!remote) {
    const uploaded = await cloud.pushSnapshot(localData, 0);
    return { ok: true, action: "uploaded", revision: Number(uploaded.revision) };
  }

  const remoteRevision = Number(remote.revision || 0);
  if (!state.revision) {
    return {
      ok: false,
      conflict: true,
      needs_choice: true,
      remote_revision: remoteRevision,
      error: "This computer has not synced with the existing cloud data. Choose Download Cloud or Replace Cloud.",
    };
  }

  const localChanged = localHash !== state.last_snapshot_hash;
  if (remoteRevision > state.revision) {
    if (localChanged) {
      return {
        ok: false,
        conflict: true,
        remote_revision: remoteRevision,
        error: "Both this computer and the cloud changed. Download or replace the cloud explicitly.",
      };
    }
    return pullCloudSnapshot();
  }

  if (remoteRevision < state.revision) {
    return {
      ok: false,
      conflict: true,
      remote_revision: remoteRevision,
      error: "The cloud revision is older than this computer. Use an explicit cloud action.",
    };
  }

  if (!localChanged) {
    return { ok: true, action: "current", revision: remoteRevision };
  }

  const uploaded = await cloud.pushSnapshot(localData, remoteRevision);
  return { ok: true, action: "uploaded", revision: Number(uploaded.revision) };
}

function buildAppMenu(win) {
  const isMac = process.platform === "darwin";

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function resolveRendererPaths() {
  // app.getAppPath():
  // - dev: project root (where package.json is)
  // - prod: .../resources/app.asar
  const appPath = app.getAppPath();

  return {
    appPath,
    indexHtml: path.join(appPath, "src", "render", "index.html"),
    preloadJs: path.join(appPath, "src", "render", "preload.js"),
    orderDetailsPreloadJs: path.join(appPath, "src", "render", "orderDetailsPreload.js"),
  };
}

function lockDownWindow(win) {
  const openExternal = (url) => {
    try {
      const protocol = new URL(url).protocol;
      if (["https:", "http:", "mailto:", "tel:"].includes(protocol)) {
        void shell.openExternal(url);
      }
    } catch {
      // Ignore malformed renderer-provided links.
    }
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const protocol = (() => {
      try { return new URL(url).protocol; } catch { return ""; }
    })();
    if (protocol === "file:") return;
    event.preventDefault();
    openExternal(url);
  });
}

function createWindow() {
  const { indexHtml, preloadJs } = resolveRendererPaths();

  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    webPreferences: {
      preload: preloadJs,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lockDownWindow(win);

  buildAppMenu(win);

  console.log("AppPath:", app.getAppPath());
  console.log("Loading UI from:", indexHtml);
  console.log("Using preload:", preloadJs);

  win.loadFile(indexHtml);

  // If UI fails to load, show a friendly error page
  win.webContents.on("did-fail-load", (_e, errorCode, errorDesc, validatedURL) => {
    console.error("did-fail-load", { errorCode, errorDesc, validatedURL, indexHtml });

    const html = `
      <html><body style="font-family:system-ui;padding:20px">
        <h2>Wallet Profit - UI failed to load</h2>
        <p><b>Error:</b> ${errorDesc} (${errorCode})</p>
        <p><b>URL:</b> ${validatedURL}</p>
        <p><b>Expected file:</b> ${indexHtml}</p>
        <p>Send this screenshot + console logs.</p>
      </body></html>`;
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  });

  return win;
}

app.whenReady().then(() => {
  // DB should ALWAYS be in userData so it persists
  const userData = app.getPath("userData");
  logger.setLogFile(userData);
  database.initDatabase(userData);
  initializeCloud();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// IPC
ipcMain.handle("import:tsv", async (_evt, text) => {
  try {
    return walletDb.importWalletTsv(text);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle("orders:get", async () => {
  return ordersDb.getOrdersReconciliation();
});

ipcMain.handle("totals:get", async (_evt, opts) => {
  return ordersDb.getTotals(opts || {});
});

ipcMain.handle("orderMeta:set", async (_evt, payload) => {
  const res = ordersDb.upsertOrderMeta(payload || {});
  if (res?.ok === false) return res;

  try {
    const cfg = walletDb.getWalletConfig();
    const usdToLbpRate = Number(cfg?.usdToLbpRate || 90000);
    salesDb.applyOrderSupplierCost(payload?.order_code, payload?.supplier_cost, usdToLbpRate);
  } catch (e) {
    logger.error("Failed to apply supplier cost override on sales rows", {
      order_code: payload?.order_code,
      error: String(e),
    });
  }

  return res;
});

ipcMain.handle("orders:getLineMeta", async (_evt, orderCode) => {
  const lines = ordersDb.getLineMetaForOrder(orderCode);
  return { ok: true, lines };
});

ipcMain.handle("orders:lineMeta:set", async (_evt, payload) => {
  const res = ordersDb.upsertLineMeta(payload || {});
  if (res?.ok === false) return res;

  try {
    const cfg = walletDb.getWalletConfig();
    const usdToLbpRate = Number(cfg?.usdToLbpRate || 90000);
    salesDb.applyLineSupplierCost(
      payload?.order_code,
      payload?.barcode,
      payload?.supplier_cost_lbp,
      usdToLbpRate
    );
  } catch (e) {
    logger.error("Failed to apply line supplier cost on sales row", {
      order_code: payload?.order_code,
      barcode: payload?.barcode,
      error: String(e),
    });
  }

  return res;
});

ipcMain.handle("supplier:reset", async () => {
  return ordersDb.resetSupplierMeta();
});

ipcMain.handle("export:csv", async () => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Export Orders CSV",
    defaultPath: (() => {
      const now = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      return `orders-reconciliation-${stamp}.csv`;
    })(),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });

  if (canceled || !filePath) return { ok: false, canceled: true };
  const outPath = ordersDb.exportOrdersCsv(filePath);
  return { ok: true, path: outPath };
});

ipcMain.handle("import:walletFile", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "Wallet Data", extensions: ["tsv", "csv", "txt"] },
    ],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  try {
    const result = walletDb.importWalletFromFile(res.filePaths[0]);
    return { ok: true, ...result, path: res.filePaths[0] };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("import:ordersCsv", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  try {
    return ordersDb.importOrdersCsvFromFile(res.filePaths[0]);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("suppliers:getAll", async () => {
  return suppliersDb.getAllSuppliers();
});

ipcMain.handle("suppliers:create", async (_evt, payload) => {
  return suppliersDb.createSupplier(payload);
});

ipcMain.handle("suppliers:update", async (_evt, payload) => {
  return suppliersDb.updateSupplier(payload || {});
});

ipcMain.handle("suppliers:rename", async (_evt, { id, name }) => {
  return suppliersDb.renameSupplier(id, name);
});

ipcMain.handle("suppliers:delete", async (_evt, id) => {
  return suppliersDb.deleteSupplier(id);
});

ipcMain.handle("suppliers:getSummary", async (_evt, opts) => {
  return ordersDb.getSupplierSummary(opts || {});
});

ipcMain.handle("open-suppliers", () => {
  const { preloadJs } = resolveRendererPaths();

  const suppliersPath = path.join(app.getAppPath(), "src", "render", "suppliers.html");

  const win = new BrowserWindow({
    width: 700,
    height: 600,
    webPreferences: {
      preload: preloadJs,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lockDownWindow(win);

  win.loadFile(suppliersPath);
});

ipcMain.handle("transactions:getSettlements", async () => {
  return transactionsDb.getSettlements();
});

ipcMain.handle("transactions:getAll", async (_evt, opts) => {
  return transactionsDb.getAllTransactions(opts || {});
});

ipcMain.handle("transactions:getTypeCounts", async () => {
  return transactionsDb.getTransactionTypeCounts();
});

ipcMain.handle("open-settlements", () => {
  const { preloadJs } = resolveRendererPaths();
  const settlementsPath = path.join(app.getAppPath(), "src", "render", "settlements.html");

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: preloadJs,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lockDownWindow(win);

  win.loadFile(settlementsPath);
});

ipcMain.handle("open-transactions", () => {
  const { preloadJs } = resolveRendererPaths();
  const transactionsPath = path.join(app.getAppPath(), "src", "render", "transactions.html");

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: preloadJs,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lockDownWindow(win);

  win.loadFile(transactionsPath);
});

ipcMain.handle("companyExpenses:getCategories", async () => {
  return companyExpensesDb.DEFAULT_CATEGORIES;
});

ipcMain.handle("companyExpenses:getAll", async (_evt, opts) => {
  return companyExpensesDb.getAll(opts || {});
});

ipcMain.handle("companyExpenses:getSummary", async (_evt, opts) => {
  return companyExpensesDb.getSummary(opts || {});
});

ipcMain.handle("companyExpenses:create", async (_evt, payload) => {
  return companyExpensesDb.createExpense(payload || {});
});

ipcMain.handle("companyExpenses:update", async (_evt, payload) => {
  return companyExpensesDb.updateExpense(payload || {});
});

ipcMain.handle("companyExpenses:delete", async (_evt, id) => {
  return companyExpensesDb.deleteExpense(id);
});

ipcMain.handle("open-company-expenses", () => {
  const { preloadJs } = resolveRendererPaths();
  const pagePath = path.join(app.getAppPath(), "src", "render", "companyExpenses.html");

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: preloadJs,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lockDownWindow(win);

  win.loadFile(pagePath);
});

ipcMain.handle("backup:export", async () => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Export Data",
    defaultPath: (() => {
      const now = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      return `wallet-profit-backup-${stamp}.db`;
    })(),
    filters: [
      { name: "SQLite Database", extensions: ["db", "sqlite"] },
      { name: "JSON Backup", extensions: ["json"] },
    ],
  });

  if (canceled || !filePath) return { ok: false, canceled: true };

  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    const outPath = walletDb.exportBackupJson(filePath);
    return { ok: true, path: outPath, format: "json" };
  }

  const outPath = await walletDb.exportSqliteBackup(filePath);
  return { ok: true, path: outPath, format: "sqlite" };
});

ipcMain.handle("backup:import", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "Backup Files", extensions: ["db", "sqlite", "json"] },
    ],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };

  const filePath = res.filePaths[0];
  const format = walletDb.detectBackupFormat(filePath);

  if (!format) {
    return { ok: false, error: "Unsupported backup file format. Use .db, .sqlite, or .json" };
  }

  if (format === "sqlite") {
    return walletDb.importSqliteBackupFromFile(filePath);
  }

  return walletDb.importBackupJsonFromFile(filePath, { replace: true });
});

ipcMain.handle("cloud:getStatus", async () => getCloudStatus());

ipcMain.handle("cloud:signIn", async (_event, credentials) => {
  try {
    const email = String(credentials?.email || "").trim();
    const password = String(credentials?.password || "");
    if (!email || !password) return { ok: false, error: "Email and password are required." };
    await cloud.signIn(email, password);
    return getCloudStatus();
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

ipcMain.handle("cloud:signOut", async () => {
  try {
    await cloud.signOut();
    return { ok: true, ...cloud.getPublicState() };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

ipcMain.handle("cloud:sync", async () => {
  try {
    return await syncCloudSnapshot();
  } catch (error) {
    return { ok: false, conflict: error.code === "CLOUD_CONFLICT", error: String(error.message || error) };
  }
});

ipcMain.handle("cloud:pull", async () => {
  try {
    return await pullCloudSnapshot();
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});

ipcMain.handle("cloud:replace", async () => {
  try {
    const remote = await cloud.getRemoteSnapshot();
    const uploaded = await cloud.pushSnapshot(
      walletDb.collectBackupData(),
      Number(remote?.revision || 0)
    );
    return { ok: true, action: "uploaded", revision: Number(uploaded.revision) };
  } catch (error) {
    return { ok: false, conflict: error.code === "CLOUD_CONFLICT", error: String(error.message || error) };
  }
});

ipcMain.handle("open-order", async (_, orderCode) => {
  const cfg = walletDb.getWalletConfig();
  if (!cfg?.token || !cfg?.storeId) {
    return;
  }

  setBaseUrl(cfg.baseUrl);
  setAuthToken(cfg.token);

  await syncOrders(cfg.storeId);

  const order = await loadDetailsByCode(orderCode);
  if (!order) return;

  const billDataList = ordersDb.getOrderBillDataList(orderCode, order.order_detail);
  const billData = billDataList[0] || null;

  const orderPath = path.join(app.getAppPath(), "src", "render", "orderDetails.html");
  const { orderDetailsPreloadJs } = resolveRendererPaths();

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: orderDetailsPreloadJs,
      nodeIntegration: false,
      contextIsolation: true,
    }
  });
  lockDownWindow(win);

  win.loadFile(orderPath);

  win.webContents.on("did-finish-load", () => {
    win.webContents.send("order-data", { order, billData, billDataList });
  });
});

ipcMain.handle("bill:exportExcel", async (_evt, billData) => {
  if (!billData?.order_code) return { ok: false, error: "Missing bill data" };
  const supplierRef = String(billData.supplier_name || "supplier")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "supplier";

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Save Supplier Bill (Excel)",
    defaultPath: `supplier-bill-${billData.order_code}-${supplierRef}.xlsx`,
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });

  if (canceled || !filePath) return { ok: false, canceled: true };

  try {
    billExport.exportBillExcel(billData, filePath);
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("bill:exportWord", async (_evt, billData) => {
  if (!billData?.order_code) return { ok: false, error: "Missing bill data" };
  const supplierRef = String(billData.supplier_name || "supplier")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "supplier";

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Save Supplier Bill (Word)",
    defaultPath: `supplier-bill-${billData.order_code}-${supplierRef}.doc`,
    filters: [
      { name: "Word Document", extensions: ["doc"] },
      { name: "HTML", extensions: ["html"] },
    ],
  });

  if (canceled || !filePath) return { ok: false, canceled: true };

  try {
    billExport.exportBillWord(billData, filePath);
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("bill:openWhatsApp", async (_evt, billData) => {
  if (!billData?.order_code) return { ok: false, error: "Missing bill data" };

  const phone = billExport.normalizeWhatsAppPhone(billData.supplier_phone);
  if (!phone) {
    return {
      ok: false,
      error: "Supplier has no phone number. Add it in Suppliers or DB Admin.",
    };
  }

  const text = billExport.buildBillPlainText(billData);
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;

  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle("open-products", () => {

  const { preloadJs } = resolveRendererPaths();

  const productsPath = path.join(
    app.getAppPath(),
    "src",
    "render",
    "products.html"
  );

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: preloadJs,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  lockDownWindow(win);

  console.log("Opening products page:", productsPath);

  win.loadFile(productsPath);

});

ipcMain.handle("open-import", () => {

  const { preloadJs } = resolveRendererPaths();

  const importPath = path.join(
    app.getAppPath(),
    "src",
    "render",
    "import.html"
  );

  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      preload: preloadJs,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  lockDownWindow(win);

  console.log("Opening import page:", importPath);

  win.loadFile(importPath);

});

ipcMain.handle("open-revenue-dashboard", () => {

  const { preloadJs } = resolveRendererPaths();

  const dashboardPath = path.join(
    app.getAppPath(),
    "src",
    "render",
    "revenueDashboard.html"
  );

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: preloadJs,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  lockDownWindow(win);

  console.log("Opening revenue dashboard:", dashboardPath);

  win.loadFile(dashboardPath);

});

ipcMain.handle("open-db-admin", () => {
  const { preloadJs } = resolveRendererPaths();

  const adminPath = path.join(
    app.getAppPath(),
    "src",
    "render",
    "dbAdmin.html"
  );

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: preloadJs,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  lockDownWindow(win);

  console.log("Opening DB admin page:", adminPath);

  win.loadFile(adminPath);
});

ipcMain.handle("products:importExcel", async () => {

  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Excel", extensions: ["xlsx"] }]
  });

  if (canceled) return null;

  const workbook = XLSX.readFile(filePaths[0]);

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const normalizeHeader = (k) =>
    String(k || "")
      .replace(/^"+|"+$/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");

  const normalizeBarcode = (v) => String(v ?? "").trim();
  const toNumberOrZero = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const getVal = (obj, aliases) => {
    for (const key of aliases) {
      if (obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== "") {
        return obj[key];
      }
    }
    return "";
  };

  const rows = raw
    .map((src) => {
      const row = {};
      for (const [k, v] of Object.entries(src)) {
        row[normalizeHeader(k)] = v;
      }

      const barcode = normalizeBarcode(getVal(row, ["barcode", "barcodes"]));
      if (!barcode) return null;

      const barcodesRaw = normalizeBarcode(getVal(row, ["barcodes"]));
      const allBarcodes = new Set(
        [barcode, ...barcodesRaw.split(",").map((x) => normalizeBarcode(x)).filter(Boolean)]
      );

      const unitPrice = toNumberOrZero(getVal(row, ["newprices", "unitpriceusd", "priceusd"]));
      const importedPrice = toNumberOrZero(getVal(row, ["unitpriceusd", "newprices", "priceusd"]));
      const itemName = String(getVal(row, ["itemname", "name"]) || "").trim();

      return {
        barcode,
        alt_barcodes: Array.from(allBarcodes).join(","),
        item_id: toNumberOrZero(getVal(row, ["itemid"])),
        source_id: toNumberOrZero(getVal(row, ["id"])),
        sku: String(getVal(row, ["sku"]) || "").trim(),
        item_name: itemName,
        brand: String(getVal(row, ["brand"]) || "").trim(),
        store_name: String(getVal(row, ["storename"]) || "").trim(),
        category: String(getVal(row, ["catref", "category"]) || "").trim(),
        category_id: toNumberOrZero(getVal(row, ["catid"])),
        sub_category: String(getVal(row, ["subcatref", "subcategory"]) || "").trim(),
        sub_category_id: toNumberOrZero(getVal(row, ["subcatid"])),
        unit_price_usd: unitPrice,
        import_price_usd: importedPrice,
        cost_usd: toNumberOrZero(getVal(row, ["costusd", "unitcostusd"])) || unitPrice,
        measurement_unit: String(getVal(row, ["measurementunit"]) || "").trim(),
        measurement_value: String(getVal(row, ["measurementvalue"]) || "").trim(),
        description: String(getVal(row, ["description"]) || "").trim(),
        image_url: String(getVal(row, ["image", "imageurl", "urlimages"]) || "").trim(),
        stock_quantity: toNumberOrZero(getVal(row, ["quantity", "stockquantity"])),
      };
    })
    .filter(Boolean);

  return productsDb.importProducts(rows);

});

ipcMain.handle("wallet:getConfig", () => walletDb.getWalletConfig());
ipcMain.handle("wallet:saveConfig", (_evt, cfg) => walletDb.saveWalletConfig(cfg));
let walletSyncRunning = false;
ipcMain.handle("wallet:sync", async () => {
  if (walletSyncRunning) return { ok: false, error: "Wallet sync is already running" };
  walletSyncRunning = true;
  try {
    return await walletDb.syncWallet();
  } finally {
    walletSyncRunning = false;
  }
});
ipcMain.handle("wallet:getSyncStatus", () => {
  const cfg = walletDb.getWalletConfig();
  if (!cfg?.storeId) return { ok: false, error: "Missing wallet store ID" };
  const walletName = cfg.wallet || "main";
  return {
    ok: true,
    checkpoint: walletSyncState.toPublicState(walletSyncState.get(cfg.storeId, walletName)),
  };
});
ipcMain.handle("wallet:resetSync", () => {
  const cfg = walletDb.getWalletConfig();
  if (!cfg?.storeId) return { ok: false, error: "Missing wallet store ID" };
  if (walletSyncRunning) return { ok: false, error: "Cannot reset while wallet sync is running" };
  const walletName = cfg.wallet || "main";
  return {
    ok: true,
    checkpoint: walletSyncState.toPublicState(walletSyncState.reset(cfg.storeId, walletName)),
  };
});
ipcMain.handle("wallet:getRemainingBalance", () => walletDb.fetchRemainingBalanceFromToters());

ipcMain.handle("products:import", (_evt, rows) => productsDb.importProducts(rows));
ipcMain.handle("products:get", () => productsDb.getProducts());
ipcMain.handle("products:update", (_evt, barcode, updates) => productsDb.updateProduct(barcode, updates));
ipcMain.handle("catalog:getProducts", async (_evt, opts) => {
  try {
    const products = await productCatalog.getProducts(opts || {});
    return { ok: true, products, source: "supabase" };
  } catch (error) {
    return {
      ok: true,
      products: productCatalog.getCachedProducts(opts || {}),
      source: "cache",
      warning: String(error.message || error),
    };
  }
});
ipcMain.handle("catalog:getProductByBarcode", async (_evt, barcode) => {
  try {
    return { ok: true, product: await productCatalog.getProductByBarcode(barcode) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});
ipcMain.handle("catalog:getMappings", async () => {
  try {
    return { ok: true, mappings: await productCatalog.getMappings(), source: "supabase" };
  } catch (error) {
    return {
      ok: true,
      mappings: productCatalogCache.getMappings(),
      source: "cache",
      warning: String(error.message || error),
    };
  }
});
ipcMain.handle("catalog:refreshCache", async () => {
  try {
    return await productCatalog.refreshCache();
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});
ipcMain.handle("catalog:createProduct", async (_evt, payload) => {
  try {
    return { ok: true, product: await productCatalog.createProduct(payload || {}) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});
ipcMain.handle("catalog:updateProduct", async (_evt, id, updates) => {
  try {
    return { ok: true, product: await productCatalog.updateProduct(id, updates || {}) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});
ipcMain.handle("catalog:archiveProduct", async (_evt, id) => {
  try {
    return { ok: true, product: await productCatalog.archiveProduct(id) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});
ipcMain.handle("catalog:restoreProduct", async (_evt, id) => {
  try {
    return { ok: true, product: await productCatalog.restoreProduct(id) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});
ipcMain.handle("catalog:setStock", async (_evt, id, inStock) => {
  try {
    const product = inStock
      ? await productCatalog.setInStock(id)
      : await productCatalog.setOutOfStock(id);
    return { ok: true, product };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
});
ipcMain.handle("products:exportExcel", async () => {
  const rows = productsDb.exportProductsExcel();

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Export Products",
    defaultPath: (() => {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      return `products-${year}-${month}-${day}.xlsx`;
    })(),
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });

  if (canceled || !filePath) {
    return { ok: false, canceled: true };
  }

  const workbook = XLSX.utils.book_new();

  const sheetData = rows.map((r) => ({
    item_id: r.item_id ?? "",
    cat_id: r.category_id ?? "",
    cat_ref: r.category ?? "",
    sub_cat_id: r.sub_category_id ?? "",
    sub_cat_ref: r.sub_category ?? "",
    measurement_unit: r.measurement_unit ?? "",
    measurement_value: r.measurement_value ?? "",
    barcode: r.barcode ?? "",
    barcodes: r.alt_barcodes || r.barcode || "",
    image: r.image_url ?? "",
    id: r.source_id ?? "",
    unit_price_usd: r.import_price_usd ?? r.unit_price_usd ?? 0,
    "NEW PRICES ": r.unit_price_usd ?? 0,
    "Store Name": r.store_name ?? "",
    "Item Name": r.item_name ?? "",
  }));

  const sheet = XLSX.utils.json_to_sheet(sheetData);
  XLSX.utils.book_append_sheet(workbook, sheet, "Products");
  XLSX.writeFile(workbook, filePath);

  return { ok: true, path: filePath, rows: rows.length };
});

ipcMain.handle("sales:report", (_evt, opts) => {
  return salesDb.getSalesReport(opts || {});
});

ipcMain.handle("sales:revenueByPeriod", (_evt, opts) => {
  return salesDb.getRevenueByPeriod(opts || {});
});

ipcMain.handle("orders:walletRevenueByPeriod", (_evt, opts) => {
  return ordersDb.getWalletRevenueByPeriod(opts || {});
});

ipcMain.handle("sales:topProductsByRevenue", (_evt, opts) => {
  return salesDb.getTopProductsByRevenue(opts || {});
});

ipcMain.handle("sales:topProductsByProfit", (_evt, opts) => {
  return salesDb.getTopProductsByProfit(opts || {});
});

ipcMain.handle("sales:profitMarginAnalysis", (_evt, opts) => {
  return salesDb.getProfitMarginAnalysis(opts || {});
});

let salesOrderSyncRunning = false;

ipcMain.handle("sales:syncFromOrders", async () => {
  const cfg = walletDb.getWalletConfig();
  if (!cfg?.token || !cfg?.storeId) {
    return { ok: false, error: "Missing wallet config (baseUrl / storeId / token)" };
  }

  if (salesOrderSyncRunning) {
    return { ok: false, error: "Order sync is already running" };
  }

  setBaseUrl(cfg.baseUrl);
  setAuthToken(cfg.token);

  salesOrderSyncRunning = true;
  try {
    const result = await runCheckpointedOrderSync(cfg.storeId);
    if (!result.ok) {
      logger.error("Order sync paused at checkpoint", {
        page: result.checkpoint?.next_page,
        order_code: result.checkpoint?.failed_order_code,
        error: result.error,
      });
    }
    return result;
  } finally {
    salesOrderSyncRunning = false;
  }
});

ipcMain.handle("sales:getOrderSyncStatus", () => {
  const cfg = walletDb.getWalletConfig();
  if (!cfg?.storeId) return { ok: false, error: "Missing wallet store ID" };
  return { ok: true, checkpoint: orderSyncState.toPublicState(orderSyncState.get(cfg.storeId)) };
});

ipcMain.handle("sales:resetOrderSync", () => {
  const cfg = walletDb.getWalletConfig();
  if (!cfg?.storeId) return { ok: false, error: "Missing wallet store ID" };
  if (salesOrderSyncRunning) return { ok: false, error: "Cannot reset while order sync is running" };
  return { ok: true, checkpoint: orderSyncState.toPublicState(orderSyncState.reset(cfg.storeId)) };
});

ipcMain.handle("sales:exportExcel", async (_evt, opts) => {
  const rows = salesDb.getSalesReport(opts || {});

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Export Sales Report",
    defaultPath: (() => {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      return `sales-report-${year}-${month}.xlsx`;
    })(),
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });

  if (canceled || !filePath) {
    return { ok: false, canceled: true };
  }

  const workbook = XLSX.utils.book_new();

  const sheetData = rows.map((r) => ({
    Barcode: r.barcode,
    "Item Name": r.item_name,
    Brand: r.brand,
    "Sold Qty": r.sold_qty,
    "Revenue (USD)": r.revenue,
    "Supplier Cost (USD)": r.supplier_cost,
    "Profit (USD)": r.profit,
  }));

  const sheet = XLSX.utils.json_to_sheet(sheetData);
  XLSX.utils.book_append_sheet(workbook, sheet, "Sales");
  XLSX.writeFile(workbook, filePath);

  return { ok: true, path: filePath, rows: rows.length };
});

ipcMain.handle("db:getTable", (_evt, { table, limit }) => {
  return adminDb.getTableRows(table, limit || 200);
});

ipcMain.handle("db:clearTable", (_evt, table) => {
  return adminDb.clearTable(table);
});

ipcMain.handle("db:listTables", () => {
  return adminDb.listTables();
});
