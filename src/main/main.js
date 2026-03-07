// src/main/main.js
const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("path");
const XLSX = require("xlsx");

const database = require("../db/database");
const walletDb = require("../db/wallet");
const ordersDb = require("../db/orders");
const productsDb = require("../db/products");
const salesDb = require("../db/sales");

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
  };
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
  return ordersDb.upsertOrderMeta(payload);
});

ipcMain.handle("supplier:reset", async () => {
  return ordersDb.resetSupplierMeta();
});

ipcMain.handle("export:csv", async () => {
  return ordersDb.exportOrdersCsv();
});

ipcMain.handle("backup:export", async () => {
  return walletDb.exportBackupJson();
});

ipcMain.handle("backup:import", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, error: "Canceled" };
  return walletDb.importBackupJsonFromFile(res.filePaths[0]);
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

  const orderPath = path.join(app.getAppPath(), "src", "render", "orderDetails.html");

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile(orderPath);

  win.webContents.on("did-finish-load", () => {
    win.webContents.send("order-data", order);
  });
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

  console.log("Opening products page:", productsPath);

  win.loadFile(productsPath);

});

ipcMain.handle("products:importExcel", async () => {

  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Excel", extensions: ["xlsx"] }]
  });

  if (canceled) return null;

  const workbook = XLSX.readFile(filePaths[0]);

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet);

  // normalize keys (remove spaces, lowercase, underscores)
  const data = raw.map((row) => {
    const normalized = {};
    for (const key in row) {
      const cleanKey = key
        .toLowerCase()
        .replace(/\s+/g, "")
        .replace(/_/g, "");
      normalized[cleanKey] = row[key];
    }
    return normalized;
  });

  const rows = data.map((r) => ({
    barcode: r.barcode,
    sku: r.sku || "",
    item_name: r.itemname,
    brand: r.brand || "",
    category: r.category,
    sub_category: r.subcategory,
    unit_price_usd: r.unitpriceusd || 0,
    cost_usd: r.unitpriceusd || 0,
    measurement_unit: r.measurementunit,
    measurement_value: r.measurementvalue,
    description: r.description,
    image_url: r.urlimages,
    stock_quantity: r.quantity || 0,
  }));

  return productsDb.importProducts(rows);

});

ipcMain.handle("wallet:getConfig", () => walletDb.getWalletConfig());
ipcMain.handle("wallet:saveConfig", (_evt, cfg) => walletDb.saveWalletConfig(cfg));
ipcMain.handle("wallet:sync", () => walletDb.syncWallet());

ipcMain.handle("products:import", (_evt, rows) => productsDb.importProducts(rows));
ipcMain.handle("products:get", () => productsDb.getProducts());

ipcMain.handle("sales:report", (_evt, opts) => {
  return salesDb.getSalesReport(opts || {});
});

ipcMain.handle("sales:syncFromOrders", async () => {
  const cfg = walletDb.getWalletConfig();
  if (!cfg?.token || !cfg?.storeId) {
    return { ok: false, error: "Missing wallet config (baseUrl / storeId / token)" };
  }

  setBaseUrl(cfg.baseUrl);
  setAuthToken(cfg.token);

  const list = await syncOrders(cfg.storeId);

  let processed = 0;

  for (const o of list || []) {
    try {
      await loadDetailsByCode(o.code);
      processed += 1;
    } catch (e) {
      logger.error("Failed to sync order to sales", { code: o.code, error: String(e) });
    }
  }

  return { ok: true, processed };
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