const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orderApi", {
  onOrderData: (callback) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("order-data", (_event, payload) => callback(payload));
  },
  openWhatsAppBill: (billData) => ipcRenderer.invoke("bill:openWhatsApp", billData),
  exportBillExcel: (billData) => ipcRenderer.invoke("bill:exportExcel", billData),
  exportBillWord: (billData) => ipcRenderer.invoke("bill:exportWord", billData),
});
