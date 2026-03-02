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
openOrder: (code) => ipcRenderer.invoke("open-order", code)
});
