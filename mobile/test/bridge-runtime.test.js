const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { indexedDB } = require("fake-indexeddb");

const Core = require("../src/mobile-core");

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

global.window = global;
global.MobileCore = Core;
global.indexedDB = indexedDB;
global.localStorage = storage();
global.sessionStorage = storage();
global.crypto = crypto.webcrypto;
global.location = { pathname: "/index.html", href: "index.html", reload() {} };
global.history = { length: 1, back() {} };
global.navigator = {};
global.document = {
  addEventListener() {},
  createElement() {
    return { click() {}, addEventListener() {}, setAttribute() {}, classList: { add() {} } };
  },
  body: { classList: { add() {} }, appendChild() {} },
};

require("../src/bridge");

test("mobile bridge persists local mutations and returns computed orders", async () => {
  const imported = await window.api.importMerge(
    "1\t-900000\tOrder 123-456\tgross_app_revenue\t2026-07-15\n" +
    "2\t90000\tOrder 123-456\tstore_listing_fee\t2026-07-15\n" +
    "3\t9900\tOrder 123-456\tvalue_added_tax\t2026-07-15"
  );
  assert.equal(imported.inserted, 3);

  const created = await window.api.suppliersCreate({ name: "Mobile Supplier", phone: "70123456" });
  assert.equal(created.ok, true);
  const saved = await window.api.ordersUpsertMeta({
    order_code: "123-456",
    supplier_id: created.supplier.id,
    supplier_cost: 270000,
    supplier_paid: true,
  });
  assert.equal(saved.ok, true);

  const orders = await window.api.ordersGetReconciliation();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].supplier_name, "Mobile Supplier");
  assert.equal(orders[0].supplier_cost, 270000);
  assert.equal(orders[0].supplier_paid, 1);
});

test("mobile bridge exposes signed-out cloud status without network access", async () => {
  const status = await window.api.cloudGetStatus();
  assert.equal(status.ok, true);
  assert.equal(status.signed_in, false);
});
