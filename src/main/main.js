// src/main/main.js
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require("electron");
const path = require("path");
const XLSX = require("xlsx");

const database = require("../db/database");
const walletDb = require("../db/wallet");
const ordersDb = require("../db/orders");
const productsDb = require("../db/products");
const salesDb = require("../db/sales");
const adminDb = require("../db/admin");
const suppliersDb = require("../db/suppliers");
const billExport = require("../db/billExport");
const transactionsDb = require("../db/transactions");
const companyExpensesDb = require("../db/companyExpenses");

const logger = require("../utils/logger");

const { syncOrders, loadDetailsByCode } = require("../services/orderService");
const { setAuthToken, setBaseUrl } = require("../services/totersApi");

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

  const billData = ordersDb.getOrderBillData(orderCode, order.order_detail);

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
    win.webContents.send("order-data", { order, billData });
  });
});

ipcMain.handle("bill:exportExcel", async (_evt, billData) => {
  if (!billData?.order_code) return { ok: false, error: "Missing bill data" };

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Save Supplier Bill (Excel)",
    defaultPath: `supplier-bill-${billData.order_code}.xlsx`,
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

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Save Supplier Bill (Word)",
    defaultPath: `supplier-bill-${billData.order_code}.doc`,
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
ipcMain.handle("wallet:sync", () => walletDb.syncWallet());
ipcMain.handle("wallet:getRemainingBalance", () => walletDb.fetchRemainingBalanceFromToters());

ipcMain.handle("products:import", (_evt, rows) => productsDb.importProducts(rows));
ipcMain.handle("products:get", () => productsDb.getProducts());
ipcMain.handle("products:update", (_evt, barcode, updates) => productsDb.updateProduct(barcode, updates));
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

ipcMain.handle("sales:syncFromOrders", async () => {
  const cfg = walletDb.getWalletConfig();
  if (!cfg?.token || !cfg?.storeId) {
    return { ok: false, error: "Missing wallet config (baseUrl / storeId / token)" };
  }

  setBaseUrl(cfg.baseUrl);
  setAuthToken(cfg.token);

  const list = await syncOrders(cfg.storeId);

  // Remove duplicates by order code
  const uniqueOrders = [];
  const seen = new Set();
  for (const o of list || []) {
    if (!o?.code || !o?.id) continue;
    if (!seen.has(o.code)) {
      seen.add(o.code);
      uniqueOrders.push(o);
    }
  }

  const skippedInvalidSummaries = Math.max(0, (list || []).length - uniqueOrders.length);

  let processed = 0;
  let detailsLoaded = 0;
  let detailsMissing = 0;
  let detailsFailed = 0;
  let ordersWithMatchedItems = 0;
  let ordersWithoutMatchedItems = 0;
  let totalOrderItems = 0;
  let matchedOrderItems = 0;
  let skippedNoBarcodeItems = 0;
  let skippedUnmatchedProductItems = 0;

  for (const o of uniqueOrders) {
    try {
      const detailed = await loadDetailsByCode(o.code);
      const sync = detailed?._salesSync || null;
      processed += 1;

      if (detailed) {
        detailsLoaded += 1;
      } else {
        detailsMissing += 1;
      }

      if (sync) {
        totalOrderItems += Number(sync.total_items || 0);
        matchedOrderItems += Number(sync.matched_items || 0);
        skippedNoBarcodeItems += Number(sync.skipped_no_barcode || 0);
        skippedUnmatchedProductItems += Number(sync.skipped_unmatched_product || 0);

        if (Number(sync.inserted_rows || 0) > 0) {
          ordersWithMatchedItems += 1;
        } else {
          ordersWithoutMatchedItems += 1;
        }
      }
    } catch (e) {
      detailsFailed += 1;
      logger.error("Failed to sync order to sales", { code: o.code, error: String(e) });
    }
  }

  return {
    ok: true,
    fetched: uniqueOrders.length,
    skippedInvalidSummaries,
    processed,
    detailsLoaded,
    detailsMissing,
    detailsFailed,
    ordersWithMatchedItems,
    ordersWithoutMatchedItems,
    totalOrderItems,
    matchedOrderItems,
    skippedNoBarcodeItems,
    skippedUnmatchedProductItems,
  };
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
