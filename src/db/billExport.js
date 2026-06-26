const fs = require("fs");
const XLSX = require("xlsx");

function currencySuffix(currency) {
  return currency === "LBP" ? " L.L" : " USD";
}

function formatDisplayAmount(amount, currency) {
  const n = Number(amount) || 0;
  if (currency === "LBP") return n.toLocaleString() + " L.L";
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function exportBillExcel(billData, filePath) {
  const currency = billData.display_currency || "USD";
  const rows = [
    ["SUPPLIER PAYMENT BILL"],
    [],
    ["Supplier", billData.supplier_name || ""],
    ["Order Code", billData.order_code || ""],
    ["Order Date", billData.order_date || ""],
    ["Status", billData.supplier_paid ? "PAID" : "UNPAID"],
    [],
    ["Item", "Barcode", "Brand", "Qty", `Unit Cost (${currency})`, `Line Cost (${currency})`],
  ];

  for (const line of billData.lines || []) {
    rows.push([
      line.item_name,
      line.barcode,
      line.brand || "",
      line.quantity,
      line.unit_cost_display,
      line.line_cost_display,
    ]);
  }

  rows.push([]);
  rows.push(["", "", "", "", "TOTAL DUE", billData.total_cost_display]);

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [{ wch: 28 }, { wch: 16 }, { wch: 14 }, { wch: 8 }, { wch: 16 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(workbook, sheet, "Supplier Bill");
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function buildBillHtml(billData) {
  const currency = billData.display_currency || "USD";
  const suffix = currencySuffix(currency);
  const lineRows = (billData.lines || [])
    .map(
      (l) => `
    <tr>
      <td>${escapeHtml(l.item_name)}</td>
      <td>${escapeHtml(l.barcode)}</td>
      <td>${escapeHtml(l.brand || "")}</td>
      <td class="num">${l.quantity}</td>
      <td class="num">${formatDisplayAmount(l.unit_cost_display, currency)}</td>
      <td class="num">${formatDisplayAmount(l.line_cost_display, currency)}</td>
    </tr>`
    )
    .join("");

  return `
    <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
      <h1 style="text-align:center; margin-bottom: 4px;">Supplier Payment Bill</h1>
      <p style="text-align:center; color:#666; margin-top: 0;">Amount payable to supplier for order fulfillment</p>
      <table style="width:100%; margin: 20px 0; border-collapse: collapse;">
        <tr><td style="padding:6px 0;"><b>Supplier:</b></td><td>${escapeHtml(billData.supplier_name)}</td></tr>
        <tr><td style="padding:6px 0;"><b>Order Code:</b></td><td>${escapeHtml(billData.order_code)}</td></tr>
        <tr><td style="padding:6px 0;"><b>Order Date:</b></td><td>${escapeHtml(billData.order_date || "-")}</td></tr>
        <tr><td style="padding:6px 0;"><b>Status:</b></td><td>${billData.supplier_paid ? "PAID" : "UNPAID"}</td></tr>
      </table>
      <table style="width:100%; border-collapse: collapse; margin-top: 16px;">
        <thead>
          <tr style="background:#f0f0f0;">
            <th style="border:1px solid #ccc; padding:8px; text-align:left;">Item</th>
            <th style="border:1px solid #ccc; padding:8px; text-align:left;">Barcode</th>
            <th style="border:1px solid #ccc; padding:8px; text-align:left;">Brand</th>
            <th style="border:1px solid #ccc; padding:8px; text-align:right;">Qty</th>
            <th style="border:1px solid #ccc; padding:8px; text-align:right;">Unit Cost</th>
            <th style="border:1px solid #ccc; padding:8px; text-align:right;">Line Cost</th>
          </tr>
        </thead>
        <tbody>
          ${lineRows || '<tr><td colspan="6" style="padding:12px; text-align:center;">No line items</td></tr>'}
        </tbody>
        <tfoot>
          <tr style="background:#fafafa; font-weight:bold;">
            <td colspan="5" style="border:1px solid #ccc; padding:10px; text-align:right;">TOTAL DUE</td>
            <td style="border:1px solid #ccc; padding:10px; text-align:right;">${formatDisplayAmount(billData.total_cost_display, currency)}</td>
          </tr>
        </tfoot>
      </table>
      <p style="margin-top: 24px; font-size: 12px; color: #666;">
        Generated on ${new Date().toLocaleString()} — Please verify quantities and amounts before payment.
      </p>
    </div>`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function exportBillWord(billData, filePath) {
  const body = buildBillHtml(billData);
  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>Supplier Bill ${escapeHtml(billData.order_code)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>
  body { font-family: Arial, sans-serif; }
  .num { text-align: right; }
  @page { size: A4; margin: 2cm; }
</style>
</head>
<body>${body}</body>
</html>`;

  fs.writeFileSync(filePath, html, "utf8");
  return filePath;
}

module.exports = {
  exportBillExcel,
  exportBillWord,
  buildBillHtml,
  formatDisplayAmount,
};
