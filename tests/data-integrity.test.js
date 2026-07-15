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
