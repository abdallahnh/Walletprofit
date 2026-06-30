/**
 * Placeholder until Phase 2–3 wire Capacitor SQLite + real handlers.
 * Defines window.api so pages load; methods return empty/error stubs.
 */
(function () {
  if (window.api) return;

  const stub = (name) => () =>
    Promise.reject(new Error(`Mobile: ${name} not implemented yet — see mobile/README.md`));

  const empty = (name) => () => Promise.resolve(name.endsWith("[]") ? [] : {});

  window.api = {
    importMerge: stub("importMerge"),
    ordersGetReconciliation: () => Promise.resolve([]),
    totalsGet: () =>
      Promise.resolve({
        orders: 0,
        gross: 0,
        netProfit: 0,
        supplierCost: 0,
      }),
    ordersUpsertMeta: stub("ordersUpsertMeta"),
    ordersGetLineMeta: () => Promise.resolve({ ok: true, lines: [] }),
    ordersUpsertLineMeta: stub("ordersUpsertLineMeta"),
    resetSupplierMeta: stub("resetSupplierMeta"),
    suppliersGetAll: () => Promise.resolve([]),
    suppliersCreate: stub("suppliersCreate"),
    suppliersUpdate: stub("suppliersUpdate"),
    suppliersRename: stub("suppliersRename"),
    suppliersDelete: stub("suppliersDelete"),
    suppliersGetSummary: () => Promise.resolve([]),
    openSuppliers: stub("openSuppliers"),
    openSettlements: stub("openSettlements"),
    openTransactions: stub("openTransactions"),
    openCompanyExpenses: stub("openCompanyExpenses"),
    companyExpensesGetCategories: () => Promise.resolve([]),
    companyExpensesGetAll: () => Promise.resolve([]),
    companyExpensesGetSummary: () => Promise.resolve([]),
    companyExpensesCreate: stub("companyExpensesCreate"),
    companyExpensesUpdate: stub("companyExpensesUpdate"),
    companyExpensesDelete: stub("companyExpensesDelete"),
    transactionsGetSettlements: () => Promise.resolve([]),
    transactionsGetAll: () => Promise.resolve([]),
    exportCsv: stub("exportCsv"),
    importWalletFile: stub("importWalletFile"),
    importOrdersCsv: stub("importOrdersCsv"),
    exportBackup: stub("exportBackup"),
    importBackup: stub("importBackup"),
    walletGetConfig: () =>
      Promise.resolve({ displayCurrency: "USD", usdToLbpRate: 90000 }),
    walletSaveConfig: stub("walletSaveConfig"),
    walletSync: stub("walletSync"),
    walletGetRemainingBalance: () => Promise.resolve({ remaining_from_toters_lbp: 0 }),
    openOrder: stub("openOrder"),
    openProducts: stub("openProducts"),
    openImport: stub("openImport"),
    productsGet: () => Promise.resolve([]),
    productsImport: stub("productsImport"),
    productsImportExcel: stub("productsImportExcel"),
    productsUpdate: stub("productsUpdate"),
    productsExportExcel: stub("productsExportExcel"),
    salesReport: () => Promise.resolve([]),
    salesRevenueByPeriod: () => Promise.resolve([]),
    walletRevenueByPeriod: () => Promise.resolve([]),
    salesTopProductsByRevenue: () => Promise.resolve([]),
    salesTopProductsByProfit: () => Promise.resolve([]),
    salesProfitMarginAnalysis: () => Promise.resolve([]),
    salesExportExcel: stub("salesExportExcel"),
    salesSyncFromOrders: stub("salesSyncFromOrders"),
    openRevenueDashboard: stub("openRevenueDashboard"),
    openDbAdmin: stub("openDbAdmin"),
    dbListTables: () => Promise.resolve([]),
    dbGetTable: () => Promise.resolve([]),
    dbClearTable: stub("dbClearTable"),
  };

  console.info("[ANWallet Mobile] bridge-stub loaded — full SQLite bridge pending Phase 2");
})();
