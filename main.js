const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require("electron");
const path = require("path");
const db = require("./db");

function resolveIndexHtml() {
  // In dev: use project folder
  if (!app.isPackaged) {
    return path.join(__dirname, "renderer", "index.html");
  }

  // In prod (Windows/mac installers): resourcesPath/app.asar/...
  // When packaged, __dirname is usually inside app.asar already, but this is more robust.
  return path.join(process.resourcesPath, "app.asar", "renderer", "index.html");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  // Simple menu to open DevTools on partner laptop
  const menu = Menu.buildFromTemplate([
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "Ctrl+R", click: () => win.reload() },
        { label: "Force Reload", accelerator: "Ctrl+Shift+R", click: () => win.webContents.reloadIgnoringCache() },
        { label: "Toggle DevTools", accelerator: "Ctrl+Shift+I", click: () => win.webContents.toggleDevTools() },
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  const indexPath = resolveIndexHtml();
  console.log("Loading UI from:", indexPath);

  win.loadFile(indexPath);

  // If it fails, show a readable error instead of white screen
  win.webContents.on("did-fail-load", (_e, errorCode, errorDesc, validatedURL) => {
    console.error("did-fail-load", { errorCode, errorDesc, validatedURL, indexPath });

    const html = `
      <html><body style="font-family:system-ui;padding:20px">
        <h2>Wallet Profit - UI failed to load</h2>
        <p><b>Error:</b> ${errorDesc} (${errorCode})</p>
        <p><b>URL:</b> ${validatedURL}</p>
        <p><b>Expected file:</b> ${indexPath}</p>
        <p>Ask Abdallah to send this screenshot + the console logs.</p>
      </body></html>`;
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  });

  return win;
}

app.whenReady().then(() => {
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
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, error: "Canceled" };
  return db.importBackupJsonFromFile(res.filePaths[0]);
});

ipcMain.handle("wallet:getConfig", () => db.getWalletConfig());
ipcMain.handle("wallet:saveConfig", (_, cfg) => db.saveWalletConfig(cfg));
ipcMain.handle("wallet:sync", () => db.syncWallet());