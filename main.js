const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const db = require("./db");

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
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
