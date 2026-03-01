// src/main/main.js
const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("path");

// IMPORTANT: with your new structure, db.js is in src/render
const db = require("../render/db");

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
  db.initDb(app.getPath("userData"));
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// IPC
ipcMain.handle("import:tsv", (_, text) => db.importTransactionsText(text));
ipcMain.handle("orders:get", (_, opts) => db.getOrdersReconciliation(opts || {}));
ipcMain.handle("totals:get", (_, opts) => db.getTotals(opts || {}));
ipcMain.handle("orderMeta:set", (_, payload) => db.upsertOrderMeta(payload));
ipcMain.handle("supplier:reset", () => db.resetSupplierMeta());

ipcMain.handle("export:csv", async () => db.exportOrdersCsv());
ipcMain.handle("backup:export", async () => db.exportBackupJson());

ipcMain.handle("backup:import", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, error: "Canceled" };
  return db.importBackupJsonFromFile(res.filePaths[0]);
});

ipcMain.handle("wallet:getConfig", () => db.getWalletConfig());
ipcMain.handle("wallet:saveConfig", (_, cfg) => db.saveWalletConfig(cfg));
ipcMain.handle("wallet:sync", () => db.syncWallet());