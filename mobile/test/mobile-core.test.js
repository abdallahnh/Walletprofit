const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const Core = require("../src/mobile-core");

function fixture() {
  const data = Core.emptyData();
  data.transactions = [
    { id: 1, amount: -2700000, type: "gross_app_revenue", order_code: "100-200", created_at: "2026-07-15" },
    { id: 2, amount: 270000, type: "store_listing_fee", order_code: "100-200", created_at: "2026-07-15" },
    { id: 3, amount: 29700, type: "value_added_tax", order_code: "100-200", created_at: "2026-07-15" },
  ];
  data.suppliers = [
    { id: 1, name: "Supplier A", phone: "111" },
    { id: 2, name: "Supplier B", phone: "222" },
  ];
  data.products = [
    { id: 1, barcode: "A", item_name: "Item A" },
    { id: 2, barcode: "B", item_name: "Item B" },
  ];
  data.sales = [
    { id: 1, order_code: "100-200", barcode: "A", product_id: 1, quantity: 1, total_sale: 10, cost: 4, profit: 6 },
    { id: 2, order_code: "100-200", barcode: "B", product_id: 2, quantity: 1, total_sale: 20, cost: 7, profit: 13 },
  ];
  data.order_items = [
    { order_code: "100-200", line_key: "barcode:A", barcode: "A", item_name_snapshot: "Item A snapshot", quantity: 1, image_url_snapshot: "https://example.com/a.jpg", supplier_id: 1, unit_supplier_cost_usd: 4, catalog_sync_status: "matched" },
    { order_code: "100-200", line_key: "barcode:B", barcode: "B", item_name_snapshot: "Item B snapshot", quantity: 1, supplier_id: 2, unit_supplier_cost_usd: 7, catalog_sync_status: "matched" },
  ];
  data.order_line_meta = [
    { order_code: "100-200", barcode: "A", supplier_id: 1, supplier_cost_lbp: 360000, supplier_paid: 1 },
    { order_code: "100-200", barcode: "B", supplier_id: 2, supplier_cost_lbp: 630000, supplier_paid: 0 },
  ];
  return data;
}

test("mobile core computes shared multi-supplier orders", () => {
  const order = Core.computeOrders(fixture()).orders[0];
  assert.equal(order.order_code, "100-200");
  assert.equal(order.gross, 2700000);
  assert.equal(order.supplier_cost, 990000);
  assert.equal(order.supplier_paid, 0);
  assert.deepEqual(order.supplier_line_ids, [1, 2]);
  assert.equal(order.is_multi_supplier, true);
  assert.equal(order.order_items[0].item_name, "Item A snapshot");
  assert.equal(order.order_items[0].image_url, "https://example.com/a.jpg");
});

test("mobile supplier summary includes distinct products and units sold", () => {
  const rows = Core.getSupplierSummary(fixture(), {});
  assert.deepEqual(rows.map((row) => ({
    name: row.supplier_name,
    products: row.product_count,
    units: row.units_sold,
  })), [
    { name: "Supplier A", products: 1, units: 1 },
    { name: "Supplier B", products: 1, units: 1 },
  ]);
});

test("mobile supplier details separate marked-paid and known outstanding snapshot costs", () => {
  const paid = Core.getSupplierDetails(fixture(), 1);
  assert.equal(paid.summary.products_sold, 1);
  assert.equal(paid.summary.units_sold, 1);
  assert.equal(paid.summary.total_cost_usd, 4);
  assert.equal(paid.summary.paid_amount_usd, 4);
  assert.equal(paid.summary.outstanding_usd, 0);
  assert.equal(paid.orders[0].supplier_paid, 1);

  const outstanding = Core.getSupplierDetails(fixture(), 2);
  assert.equal(outstanding.summary.total_cost_usd, 7);
  assert.equal(outstanding.summary.paid_amount_usd, 0);
  assert.equal(outstanding.summary.outstanding_usd, 7);
  assert.equal(outstanding.orders[0].supplier_paid, 0);
});

test("mobile core creates one bill per supplier", () => {
  const bills = Core.buildBillDataList(fixture(), "100-200");
  assert.deepEqual(
    bills.map((bill) => ({ name: bill.supplier_name, total: bill.supplier_cost_lbp, items: bill.lines.map((line) => line.barcode) })),
    [
      { name: "Supplier A", total: 360000, items: ["A"] },
      { name: "Supplier B", total: 630000, items: ["B"] },
    ]
  );
});

test("mobile core parses the Toters remaining balance like desktop", () => {
  const parsed = Core.parseWalletSummaryEntry({
    store: { ref: "Wallet Profit", currency: { ref: "LBP" } },
    summary: [
      { wallet: "cash", amount: 250000 },
      { wallet: "main", amount: -11356 },
    ],
  }, "main");

  assert.deepEqual(parsed, {
    raw_amount_lbp: -11356,
    remaining_from_toters_lbp: 11356,
    wallet: "main",
    store_name: "Wallet Profit",
    currency_ref: "LBP",
  });
});

test("mobile profit ledger preserves historical and current split versions", () => {
  const data = Core.emptyData();
  data.transactions = [
    { id: 1, amount: -600000, type: "gross_app_revenue", order_code: "OLD-1", created_at: "2026-07-20" },
    { id: 2, amount: -300000, type: "gross_app_revenue", order_code: "10863-98881", created_at: "2026-07-24" },
    { id: 3, amount: -200000, type: "gross_app_revenue", order_code: "NEW-2", created_at: "2026-07-25" },
  ];
  const historical = Core.previewHistoricalProfit(data, "10863-98881");
  assert.deepEqual(historical.allocations.map((row) => row.amount_lbp), [300000, 100000, 200000]);
  assert.equal(Core.postProfitPreview(data, historical, {}).ok, true);
  const current = Core.previewCurrentProfit(data);
  assert.equal(current.total_profit_lbp, 500000);
  assert.deepEqual(current.allocations.map((row) => row.amount_lbp), [215000, 170000, 115000]);
  assert.equal(Core.postProfitPreview(data, current, {}).ok, true);
  assert.equal(Core.getProfitSummary(data).remaining_profit_lbp, 0);
});

test("mobile bridge covers the desktop preload API contract", () => {
  const root = path.join(__dirname, "..", "..");
  const preload = fs.readFileSync(path.join(root, "src", "render", "preload.js"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "mobile", "src", "bridge.js"), "utf8");
  const methods = [...preload.matchAll(/^\s+([A-Za-z0-9_]+):/gm)].map((match) => match[1]);
  const missing = methods.filter((name) => !new RegExp(`\\b${name}\\s*(?:[:,])`).test(bridge));
  assert.deepEqual(missing, []);
});

test("every built HTML page loads the mobile bridge", () => {
  const www = path.join(__dirname, "..", "www");
  const pages = fs.readdirSync(www).filter((name) => name.endsWith(".html"));
  assert.ok(pages.length >= 9);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(www, page), "utf8");
    assert.match(html, /src="mobile-core\.js(?:\?v=[^"]+)?"/);
    assert.match(html, /src="bridge\.js(?:\?v=[^"]+)?"/);
    assert.match(html, /href="mobile\.css(?:\?v=[^"]+)?"/);
  }
});

test("phone wallet records use responsive cards instead of a wide table", () => {
  const root = path.join(__dirname, "..", "..");
  const transactions = fs.readFileSync(path.join(root, "src", "render", "transactions.html"), "utf8");
  const settlements = fs.readFileSync(path.join(root, "src", "render", "settlements.html"), "utf8");
  const mobileCss = fs.readFileSync(path.join(root, "mobile", "src", "mobile.css"), "utf8");

  assert.match(transactions, /class="mobile-card-table transaction-table"/);
  assert.match(transactions, /data-mobile-label="Amount"/);
  assert.match(settlements, /class="mobile-card-table settlement-table"/);
  assert.match(mobileCss, /@media \(max-width: 600px\)/);
  assert.match(mobileCss, /\.mobile-card-table tbody tr/);
  assert.match(mobileCss, /#table > tbody > tr\[data-order\]/);
});

test("profit distribution page exposes historical cutoff, latest split, and version history", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "src", "render", "profitDistributions.html"), "utf8");
  assert.match(html, /10863-98881/);
  assert.match(html, /Check Latest Profit/);
  assert.match(html, /Save as New Active Rule/);
  assert.match(html, /Distribution history/);
});
