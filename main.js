const { app, BrowserWindow, ipcMain, dialog, protocol } = require("electron");
const path = require("path");
const db = require("./db");

// IMPORTANT: must be called before app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
]);

let mainWindow = null;

function registerAppProtocol() {
  // Maps: app://-/index.html  ->  <appDir>/renderer/index.html
  protocol.registerFileProtocol("app", (request, callback) => {
    try {
      const url = new URL(request.url);

      // normalize path (avoid .. traversal)
      let relPath = decodeURIComponent(url.pathname || "");
      if (relPath.startsWith("/")) relPath = relPath.slice(1);
      if (!relPath) relPath = "index.html";

      // force everything to come only from renderer folder
      const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
      const filePath = path.join(__dirname, "renderer", safePath);

      callback({ path: filePath });
    } catch (e) {
      console.error("app:// protocol error", e);
      callback({ error: -2 }); // FILE_NOT_FOUND
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Helpful diagnostics (you can keep these)
  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
    console.error("did-fail-load:", { errorCode, errorDescription, validatedURL });
  });

  // Load via custom protocol (NOT file://)
  mainWindow.loadURL("app://-/index.html");
}

app.whenReady().then(() => {
  registerAppProtocol();
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