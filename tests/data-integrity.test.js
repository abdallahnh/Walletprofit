const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const database = require("../src/db/database");
const walletDb = require("../src/db/wallet");
const productsDb = require("../src/db/products");
const salesDb = require("../src/db/sales");
const suppliersDb = require("../src/db/suppliers");
const ordersDb = require("../src/db/orders");
const orderSyncState = require("../src/db/orderSyncState");
const walletSyncState = require("../src/db/walletSyncState");
const { runCheckpointedOrderSync } = require("../src/services/salesOrderSync");
const { createSupabaseCloud, snapshotHash } = require("../src/services/supabaseCloud");

function createDatabase() {
  database.closeDatabase();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-profit-test-"));
  database.initDatabase(directory);
  return { db: database.getDb(), directory };
}

test.afterEach(() => {
  database.closeDatabase();
});

test("JSON replacement restore includes company expenses", () => {
  const { db } = createDatabase();
  db.prepare(`
    INSERT INTO company_expenses (category, description, amount_lbp, expense_date)
    VALUES ('Old', 'remove me', 1, '2026-01-01')
  `).run();

  const result = walletDb.importBackupData(
    {
      transactions: [],
      company_expenses: [
        {
          id: 7,
          category: "Packaging",
          description: "Boxes",
          amount_lbp: 250000,
          expense_date: "2026-07-15",
          notes: "",
          created_at: "2026-07-15T10:00:00.000Z",
          updated_at: "2026-07-15T10:00:00.000Z",
        },
      ],
    },
    { replace: true }
  );

  assert.equal(result.imported_company_expenses, 1);
  assert.deepEqual(
    db.prepare("SELECT id, category, description, amount_lbp FROM company_expenses").all(),
    [{ id: 7, category: "Packaging", description: "Boxes", amount_lbp: 250000 }]
  );
});

test("deleting a supplier clears order and line references", () => {
  const { db } = createDatabase();
  const created = suppliersDb.createSupplier({ name: "Supplier A" });
  const supplierId = Number(created.supplier.id);

  db.prepare("INSERT INTO order_meta (order_code, supplier_id) VALUES (?, ?)").run(
    "100-200",
    supplierId
  );
  db.prepare(
    "INSERT INTO order_line_meta (order_code, barcode, supplier_id) VALUES (?, ?, ?)"
  ).run("100-200", "ABC", supplierId);

  suppliersDb.deleteSupplier(supplierId);

  assert.equal(db.prepare("SELECT supplier_id FROM order_meta").get().supplier_id, null);
  assert.equal(db.prepare("SELECT supplier_id FROM order_line_meta").get().supplier_id, null);
});

test("sales sync preserves existing rows when no products match", () => {
  const { db } = createDatabase();
  productsDb.importProducts([
    {
      barcode: "KNOWN",
      item_name: "Known",
      sku: "",
      brand: "",
      store_name: "",
      item_id: 1,
      source_id: 1,
      category: "",
      category_id: 0,
      sub_category: "",
      sub_category_id: 0,
      unit_price_usd: 10,
      cost_usd: 5,
      measurement_unit: "",
      measurement_value: "",
      description: "",
      image_url: "",
      alt_barcodes: "KNOWN",
      import_price_usd: 10,
      stock_quantity: 1,
    },
  ]);

  const product = db.prepare("SELECT id FROM products WHERE barcode = 'KNOWN'").get();
  db.prepare(`
    INSERT INTO sales (
      order_code, barcode, product_id, quantity, unit_price,
      cost, total_sale, profit, created_at
    ) VALUES (?, ?, ?, 1, 10, 5, 10, 5, ?)
  `).run("100-200", "KNOWN", product.id, "2026-07-15T10:00:00.000Z");

  const result = salesDb.recordOrderItemsToSales({
    code: "100-200",
    order_detail: [
      {
        item: { barcode: "UNKNOWN" },
        quantity: 1,
        item_price: 900000,
      },
    ],
  });

  assert.equal(result.preserved_existing, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sales WHERE order_code = ?").get("100-200").count, 1);
});

test("wallet sync does not send credentials to a cross-origin pagination URL", async () => {
  createDatabase();
  walletDb.saveWalletConfig({
    baseUrl: "https://dashboard.toters-api.com",
    storeId: "42",
    wallet: "main",
    token: "secret-token",
  });

  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      json: async () => ({
        data: {
          wallet: {
            data: [{ id: 1, amount: 100, reason: "test" }],
            next_page_url: "https://attacker.example/steal?page=2",
          },
        },
      }),
    };
  };

  try {
    const result = await walletDb.syncWallet();
    assert.equal(result.ok, false);
    assert.match(result.error, /untrusted origin/i);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers.Authorization, "Bearer secret-token");
  } finally {
    global.fetch = originalFetch;
  }
});

test("wallet config rejects non-HTTP base URLs", () => {
  createDatabase();
  const result = walletDb.saveWalletConfig({ baseUrl: "file:///tmp/credentials" });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP or HTTPS/);
});

test("order sync resumes the failed page without repeating completed orders", async () => {
  createDatabase();
  const storeId = "store-42";
  const fetchedPages = [];
  const loadedCodes = [];
  let failOrderB = true;
  let pageOneOrders = [{ code: "A", id: 1 }, { code: "B", id: 2 }];

  const fetchPage = async (_storeId, page) => {
    fetchedPages.push(page);
    if (page === 1) {
      return {
        orders: pageOneOrders,
        rawCount: pageOneOrders.length,
        hasNextPage: true,
      };
    }
    return {
      orders: [{ code: "C", id: 3 }],
      rawCount: 1,
      hasNextPage: false,
    };
  };

  const loadDetails = async (code) => {
    loadedCodes.push(code);
    if (code === "B" && failOrderB) throw new Error("temporary API failure");
    return { code, _salesSync: { total_items: 1, matched_items: 1, inserted_rows: 1 } };
  };

  const first = await runCheckpointedOrderSync(storeId, { fetchPage, loadDetails });
  assert.equal(first.ok, false);
  assert.equal(first.checkpoint.status, "failed");
  assert.equal(first.checkpoint.next_page, 1);
  assert.equal(first.checkpoint.completed_on_page, 1);
  assert.equal(first.checkpoint.failed_order_code, "B");
  assert.deepEqual(loadedCodes, ["A", "B"]);

  failOrderB = false;
  const second = await runCheckpointedOrderSync(storeId, { fetchPage, loadDetails });
  assert.equal(second.ok, true);
  assert.equal(second.startPage, 1);
  assert.equal(second.skippedAlreadyCompleted, 1);
  assert.equal(second.checkpoint.status, "completed");
  assert.equal(second.checkpoint.last_completed_page, 2);
  assert.equal(second.checkpoint.last_synced_head_code, "A");
  assert.deepEqual(loadedCodes, ["A", "B", "B", "C"]);
  assert.deepEqual(fetchedPages, [1, 1, 2]);

  const third = await runCheckpointedOrderSync(storeId, { fetchPage, loadDetails });
  assert.equal(third.ok, true);
  assert.equal(third.stoppedAtWatermark, true);
  assert.equal(third.processed, 0);
  assert.equal(third.checkpoint.last_completed_page, 2);
  assert.deepEqual(loadedCodes, ["A", "B", "B", "C"]);
  assert.deepEqual(fetchedPages, [1, 1, 2, 1]);

  pageOneOrders = [{ code: "D", id: 4 }, ...pageOneOrders];
  const fourth = await runCheckpointedOrderSync(storeId, { fetchPage, loadDetails });
  assert.equal(fourth.ok, true);
  assert.equal(fourth.stoppedAtWatermark, true);
  assert.equal(fourth.processed, 1);
  assert.equal(fourth.checkpoint.last_synced_head_code, "D");
  assert.equal(fourth.checkpoint.last_completed_page, 2);
  assert.deepEqual(loadedCodes, ["A", "B", "B", "C", "D"]);
});

test("resetting order sync clears the saved resume point", () => {
  createDatabase();
  const storeId = "store-7";
  orderSyncState.begin(storeId);
  orderSyncState.markOrderCompleted(storeId, 1, "A");
  orderSyncState.advanceToPage(storeId, 2);

  const reset = orderSyncState.reset(storeId);
  assert.equal(reset.status, "idle");
  assert.equal(reset.next_page, 1);
  assert.deepEqual(reset.completed_order_codes, []);
  assert.equal(orderSyncState.get(storeId).status, "idle");
});

test("wallet sync resumes a failed page and then stops at its transaction watermark", async () => {
  const { db } = createDatabase();
  walletDb.saveWalletConfig({
    baseUrl: "https://dashboard.toters-api.com",
    storeId: "42",
    wallet: "main",
    token: "secret-token",
  });

  const originalFetch = global.fetch;
  const fetchedPages = [];
  let failPageTwo = true;
  let pageOneItems = [
    { id: 3, store_id: 42, amount: 300, wallet: "main", reason: "Newest" },
    { id: 2, store_id: 42, amount: 200, wallet: "main", reason: "Middle" },
  ];

  global.fetch = async (url) => {
    const page = Number(new URL(String(url)).searchParams.get("page"));
    fetchedPages.push(page);
    if (page === 2 && failPageTwo) throw new Error("temporary wallet API failure");
    const items = page === 1
      ? pageOneItems
      : [{ id: 1, store_id: 42, amount: 100, wallet: "main", reason: "Oldest" }];
    return {
      ok: true,
      json: async () => ({
        data: {
          wallet: {
            data: items,
            next_page_url: page === 1
              ? "https://dashboard.toters-api.com/api/wallet?page=2"
              : null,
          },
        },
      }),
    };
  };

  try {
    const first = await walletDb.syncWallet();
    assert.equal(first.ok, false);
    assert.equal(first.checkpoint.status, "failed");
    assert.equal(first.checkpoint.next_page, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transactions").get().count, 2);

    failPageTwo = false;
    const second = await walletDb.syncWallet();
    assert.equal(second.ok, true);
    assert.equal(second.startPage, 2);
    assert.equal(second.checkpoint.last_synced_head_id, "3");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transactions").get().count, 3);

    const third = await walletDb.syncWallet();
    assert.equal(third.ok, true);
    assert.equal(third.stoppedAtWatermark, true);
    assert.equal(third.totalConsidered, 0);
    assert.equal(third.checkpoint.last_completed_page, 2);

    pageOneItems = [
      { id: 4, store_id: 42, amount: 400, wallet: "main", reason: "New arrival" },
      ...pageOneItems,
    ];
    const fourth = await walletDb.syncWallet();
    assert.equal(fourth.ok, true);
    assert.equal(fourth.stoppedAtWatermark, true);
    assert.equal(fourth.totalInserted, 1);
    assert.equal(fourth.checkpoint.last_synced_head_id, "4");
    assert.equal(fourth.checkpoint.last_completed_page, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transactions").get().count, 4);
    assert.deepEqual(fetchedPages, [1, 2, 2, 1, 1]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("resetting wallet sync clears only its checkpoint", () => {
  const { db } = createDatabase();
  db.prepare(
    "INSERT INTO transactions (id, amount, wallet, reason) VALUES (1, 100, 'main', 'keep me')"
  ).run();
  walletSyncState.begin("42", "main");
  walletSyncState.setCycleHead("42", "main", 1);
  walletSyncState.advanceToPage("42", "main", 3);

  const reset = walletSyncState.reset("42", "main");
  assert.equal(reset.status, "idle");
  assert.equal(reset.next_page, 1);
  assert.equal(reset.last_synced_head_id, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM transactions").get().count, 1);
});

test("completed v1 sync checkpoints rebuild once to restore historical page depth", () => {
  const { db } = createDatabase();
  db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
    "ordersSyncCheckpoint:legacy-store",
    JSON.stringify({
      version: 1,
      store_id: "legacy-store",
      status: "completed",
      next_page: 1,
      last_completed_page: 1,
      last_synced_head_code: "ORDER-1",
    })
  );
  db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
    "walletSyncCheckpoint:legacy-store:main",
    JSON.stringify({
      version: 1,
      store_id: "legacy-store",
      wallet: "main",
      status: "completed",
      next_page: 1,
      last_completed_page: 1,
      last_synced_head_id: "100",
    })
  );

  const orderState = orderSyncState.get("legacy-store");
  const walletState = walletSyncState.get("legacy-store", "main");
  assert.equal(orderState.version, 2);
  assert.equal(orderState.status, "idle");
  assert.equal(orderState.last_synced_head_code, null);
  assert.equal(walletState.version, 2);
  assert.equal(walletState.status, "idle");
  assert.equal(walletState.last_synced_head_id, null);
});

test("multi-supplier orders create one bill per supplier", () => {
  const { db } = createDatabase();
  const productFixture = (overrides) => ({
    barcode: "",
    item_name: "",
    sku: "",
    brand: "",
    store_name: "",
    item_id: "",
    source_id: "",
    category: "",
    category_id: "",
    sub_category: "",
    sub_category_id: "",
    unit_price_usd: 0,
    cost_usd: 0,
    measurement_unit: "",
    measurement_value: "",
    description: "",
    image_url: "",
    alt_barcodes: "",
    import_price_usd: 0,
    stock_quantity: 0,
    ...overrides,
  });
  productsDb.importProducts([
    productFixture({
      barcode: "ITEM-A",
      item_name: "Item A",
      unit_price_usd: 10,
      cost_usd: 4,
      stock_quantity: 10,
    }),
    productFixture({
      barcode: "ITEM-B",
      item_name: "Item B",
      unit_price_usd: 20,
      cost_usd: 7,
      stock_quantity: 10,
    }),
  ]);
  const products = db.prepare(
    "SELECT id, barcode FROM products WHERE barcode IN ('ITEM-A', 'ITEM-B')"
  ).all();
  const productId = new Map(products.map((product) => [product.barcode, product.id]));
  const supplierA = suppliersDb.createSupplier({ name: "Supplier A", phone: "111" }).supplier;
  const supplierB = suppliersDb.createSupplier({ name: "Supplier B", phone: "222" }).supplier;

  db.prepare(
    "INSERT INTO transactions (id, amount, reason, type, order_code, created_at) " +
    "VALUES (1, 2700000, 'Order 500-600', 'order', '500-600', '2026-07-15T10:00:00Z')"
  ).run();
  const insertSale = db.prepare(
    "INSERT INTO sales " +
    "(order_code, barcode, product_id, quantity, unit_price, cost, total_sale, profit) " +
    "VALUES (?, ?, ?, 1, ?, ?, ?, ?)"
  );
  insertSale.run("500-600", "ITEM-A", productId.get("ITEM-A"), 10, 4, 10, 6);
  insertSale.run("500-600", "ITEM-B", productId.get("ITEM-B"), 20, 7, 20, 13);
  ordersDb.upsertLineMeta({
    order_code: "500-600",
    barcode: "ITEM-A",
    supplier_id: supplierA.id,
    supplier_cost_lbp: 360000,
    supplier_paid: true,
  });
  ordersDb.upsertLineMeta({
    order_code: "500-600",
    barcode: "ITEM-B",
    supplier_id: supplierB.id,
    supplier_cost_lbp: 630000,
    supplier_paid: false,
  });

  const bills = ordersDb.getOrderBillDataList("500-600");
  assert.equal(bills.length, 2);
  assert.deepEqual(
    bills.map((bill) => ({
      supplier: bill.supplier_name,
      phone: bill.supplier_phone,
      paid: bill.supplier_paid,
      barcodes: bill.lines.map((line) => line.barcode),
      total_lbp: bill.supplier_cost_lbp,
    })),
    [
      {
        supplier: "Supplier A",
        phone: "111",
        paid: true,
        barcodes: ["ITEM-A"],
        total_lbp: 360000,
      },
      {
        supplier: "Supplier B",
        phone: "222",
        paid: false,
        barcodes: ["ITEM-B"],
        total_lbp: 630000,
      },
    ]
  );
});

test("cloud snapshot hashing ignores only its export timestamp", () => {
  const first = snapshotHash({ exported_at: "2026-01-01", transactions: [{ id: 1 }] });
  const second = snapshotHash({ exported_at: "2026-07-15", transactions: [{ id: 1 }] });
  const changed = snapshotHash({ exported_at: "2026-07-15", transactions: [{ id: 2 }] });
  assert.equal(first, second);
  assert.notEqual(first, changed);
});

test("cloud upload uses an authenticated revision and detects stale writes", async () => {
  const calls = [];
  const responses = [
    {
      access_token: "access-token",
      refresh_token: "refresh-token",
      user: { id: "user-1", email: "member@example.com" },
    },
    [{ revision: 1 }],
    [],
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const payload = responses.shift();
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    };
  };
  const savedStates = [];
  const cloud = createSupabaseCloud({
    fetchImpl,
    onStateChange: (state) => savedStates.push(state),
  });

  const signedIn = await cloud.signIn("member@example.com", "password");
  assert.equal(signedIn.email, "member@example.com");
  const uploaded = await cloud.pushSnapshot({ transactions: [{ id: 1 }] }, 0);
  assert.equal(uploaded.revision, 1);
  assert.equal(cloud.getPublicState().revision, 1);
  assert.match(calls[1].options.headers.Authorization, /^Bearer access-token$/);

  await assert.rejects(
    () => cloud.pushSnapshot({ transactions: [{ id: 2 }] }, 1),
    (error) => error.code === "CLOUD_CONFLICT"
  );
  assert.equal(savedStates.at(-1).revision, 1);
});
