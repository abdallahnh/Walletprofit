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
    assert.match(html, /src="mobile-core\.js"/);
    assert.match(html, /src="bridge\.js"/);
    assert.match(html, /href="mobile\.css"/);
  }
});
