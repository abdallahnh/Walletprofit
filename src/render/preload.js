const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Transactions import
  importMerge: (text) => ipcRenderer.invoke("import:tsv", text),

  // Orders + totals
  ordersGetReconciliation: () => ipcRenderer.invoke("orders:get", {}),
  totalsGet: (opts) => ipcRenderer.invoke("totals:get", opts || {}),

  // Supplier meta
  ordersUpsertMeta: (payload) => ipcRenderer.invoke("orderMeta:set", payload),
  ordersGetLineMeta: (orderCode) => ipcRenderer.invoke("orders:getLineMeta", orderCode),
  ordersUpsertLineMeta: (payload) => ipcRenderer.invoke("orders:lineMeta:set", payload),
  resetSupplierMeta: () => ipcRenderer.invoke("supplier:reset"),
  suppliersGetAll: () => ipcRenderer.invoke("suppliers:getAll"),
  suppliersCreate: (payload) => ipcRenderer.invoke("suppliers:create", payload),
  suppliersUpdate: (payload) => ipcRenderer.invoke("suppliers:update", payload),
  suppliersRename: (id, name) => ipcRenderer.invoke("suppliers:rename", { id, name }),
  suppliersDelete: (id) => ipcRenderer.invoke("suppliers:delete", id),
  suppliersGetSummary: (opts) => ipcRenderer.invoke("suppliers:getSummary", opts || {}),
  openSuppliers: () => ipcRenderer.invoke("open-suppliers"),
  openSettlements: () => ipcRenderer.invoke("open-settlements"),
  openTransactions: () => ipcRenderer.invoke("open-transactions"),
  openCompanyExpenses: () => ipcRenderer.invoke("open-company-expenses"),
  companyExpensesGetCategories: () => ipcRenderer.invoke("companyExpenses:getCategories"),
  companyExpensesGetAll: (opts) => ipcRenderer.invoke("companyExpenses:getAll", opts || {}),
  companyExpensesGetSummary: (opts) => ipcRenderer.invoke("companyExpenses:getSummary", opts || {}),
  companyExpensesCreate: (payload) => ipcRenderer.invoke("companyExpenses:create", payload),
  companyExpensesUpdate: (payload) => ipcRenderer.invoke("companyExpenses:update", payload),
  companyExpensesDelete: (id) => ipcRenderer.invoke("companyExpenses:delete", id),
  transactionsGetSettlements: () => ipcRenderer.invoke("transactions:getSettlements"),
  transactionsGetAll: (opts) => ipcRenderer.invoke("transactions:getAll", opts || {}),

  // Export / backup
  exportCsv: () => ipcRenderer.invoke("export:csv"),
  importWalletFile: () => ipcRenderer.invoke("import:walletFile"),
  importOrdersCsv: () => ipcRenderer.invoke("import:ordersCsv"),
  exportBackup: () => ipcRenderer.invoke("backup:export"),
  importBackup: () => ipcRenderer.invoke("backup:import"),

  // Shared Supabase cloud data
  cloudGetStatus: () => ipcRenderer.invoke("cloud:getStatus"),
  cloudSignIn: (email, password) => ipcRenderer.invoke("cloud:signIn", { email, password }),
  cloudSignOut: () => ipcRenderer.invoke("cloud:signOut"),
  cloudSync: () => ipcRenderer.invoke("cloud:sync"),
  cloudPull: () => ipcRenderer.invoke("cloud:pull"),
  cloudReplace: () => ipcRenderer.invoke("cloud:replace"),

  // Wallet settings + sync
  walletGetConfig: () => ipcRenderer.invoke("wallet:getConfig"),
  walletSaveConfig: (cfg) => ipcRenderer.invoke("wallet:saveConfig", cfg),
  walletSync: () => ipcRenderer.invoke("wallet:sync"),
  walletGetSyncStatus: () => ipcRenderer.invoke("wallet:getSyncStatus"),
  walletResetSync: () => ipcRenderer.invoke("wallet:resetSync"),
  walletGetRemainingBalance: () => ipcRenderer.invoke("wallet:getRemainingBalance"),
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
  catalogGetProducts: (opts) => ipcRenderer.invoke("catalog:getProducts", opts || {}),
  catalogGetProductByBarcode: (barcode) => ipcRenderer.invoke("catalog:getProductByBarcode", barcode),
  catalogGetMappings: () => ipcRenderer.invoke("catalog:getMappings"),
  catalogRefreshCache: () => ipcRenderer.invoke("catalog:refreshCache"),
  catalogCreateProduct: (payload) => ipcRenderer.invoke("catalog:createProduct", payload || {}),
  catalogUpdateProduct: (id, updates) => ipcRenderer.invoke("catalog:updateProduct", id, updates || {}),
  catalogArchiveProduct: (id) => ipcRenderer.invoke("catalog:archiveProduct", id),
  catalogRestoreProduct: (id) => ipcRenderer.invoke("catalog:restoreProduct", id),
  catalogSetStock: (id, inStock) => ipcRenderer.invoke("catalog:setStock", id, !!inStock),

  // Sales reports
  salesReport: (opts) => ipcRenderer.invoke("sales:report", opts || {}),
  salesRevenueByPeriod: (opts) => ipcRenderer.invoke("sales:revenueByPeriod", opts || {}),
  walletRevenueByPeriod: (opts) => ipcRenderer.invoke("orders:walletRevenueByPeriod", opts || {}),
  salesTopProductsByRevenue: (opts) => ipcRenderer.invoke("sales:topProductsByRevenue", opts || {}),
  salesTopProductsByProfit: (opts) => ipcRenderer.invoke("sales:topProductsByProfit", opts || {}),
  salesProfitMarginAnalysis: (opts) => ipcRenderer.invoke("sales:profitMarginAnalysis", opts || {}),
  salesExportExcel: (opts) => ipcRenderer.invoke("sales:exportExcel", opts || {}),
  salesSyncFromOrders: () => ipcRenderer.invoke("sales:syncFromOrders"),
  salesGetOrderSyncStatus: () => ipcRenderer.invoke("sales:getOrderSyncStatus"),
  salesResetOrderSync: () => ipcRenderer.invoke("sales:resetOrderSync"),

  // Revenue Dashboard
  openRevenueDashboard: () => ipcRenderer.invoke("open-revenue-dashboard"),

  // DB admin
  openDbAdmin: () => ipcRenderer.invoke("open-db-admin"),
  dbListTables: () => ipcRenderer.invoke("db:listTables"),
  dbGetTable: (table, limit) => ipcRenderer.invoke("db:getTable", { table, limit }),
  dbClearTable: (table) => ipcRenderer.invoke("db:clearTable", table),
});
