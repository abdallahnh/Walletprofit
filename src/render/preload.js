const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Transactions import
  importMerge: (text) => ipcRenderer.invoke("import:tsv", text),

  // Orders + totals
  ordersGetReconciliation: () => ipcRenderer.invoke("orders:get", {}),
  totalsGet: (opts) => ipcRenderer.invoke("totals:get", opts || {}),

  // Supplier meta
  ordersUpsertMeta: (payload) => ipcRenderer.invoke("orderMeta:set", payload),
  resetSupplierMeta: () => ipcRenderer.invoke("supplier:reset"),

  // Export / backup
  exportCsv: () => ipcRenderer.invoke("export:csv"),
  exportBackup: () => ipcRenderer.invoke("backup:export"),
  importBackup: () => ipcRenderer.invoke("backup:import"),

  // Wallet settings + sync
  walletGetConfig: () => ipcRenderer.invoke("wallet:getConfig"),
  walletSaveConfig: (cfg) => ipcRenderer.invoke("wallet:saveConfig", cfg),
  walletSync: () => ipcRenderer.invoke("wallet:sync"),
  openOrder: (code) => ipcRenderer.invoke("open-order", code),

  openProducts: () => ipcRenderer.invoke("open-products"),

  // Import page
  openImport: () => ipcRenderer.invoke("open-import"),

  // Products
  productsGet: () => ipcRenderer.invoke("products:get"),
  productsImport: (rows) => ipcRenderer.invoke("products:import", rows),
  productsImportExcel: () => ipcRenderer.invoke("products:importExcel"),
  productsUpdate: (barcode, updates) => ipcRenderer.invoke("products:update", barcode, updates),
  productsExportExcel: () => ipcRenderer.invoke("products:exportExcel"),

  // Sales reports
  salesReport: (opts) => ipcRenderer.invoke("sales:report", opts || {}),
  salesRevenueByPeriod: (opts) => ipcRenderer.invoke("sales:revenueByPeriod", opts || {}),
  salesTopProductsByRevenue: (opts) => ipcRenderer.invoke("sales:topProductsByRevenue", opts || {}),
  salesTopProductsByProfit: (opts) => ipcRenderer.invoke("sales:topProductsByProfit", opts || {}),
  salesProfitMarginAnalysis: (opts) => ipcRenderer.invoke("sales:profitMarginAnalysis", opts || {}),
  salesExportExcel: (opts) => ipcRenderer.invoke("sales:exportExcel", opts || {}),
  salesSyncFromOrders: () => ipcRenderer.invoke("sales:syncFromOrders"),

  // Revenue Dashboard
  openRevenueDashboard: () => ipcRenderer.invoke("open-revenue-dashboard"),

  // DB admin
  openDbAdmin: () => ipcRenderer.invoke("open-db-admin"),
  dbGetTable: (table, limit) => ipcRenderer.invoke("db:getTable", { table, limit }),
  dbClearTable: (table) => ipcRenderer.invoke("db:clearTable", table),
});
