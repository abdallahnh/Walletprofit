const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const database = require("../src/db/database");
const distributions = require("../src/db/profitDistributions");
const walletDb = require("../src/db/wallet");

function setup() {
  database.closeDatabase();
  database.initDatabase(fs.mkdtempSync(path.join(os.tmpdir(), "wallet-profit-splits-")));
  const db = database.getDb();
  const insert = db.prepare(`
    INSERT INTO transactions (id, amount, reason, type, created_at, order_code)
    VALUES (?, ?, ?, 'gross_app_revenue', ?, ?)
  `);
  insert.run(1, -900000, "Order OLD-1", "2026-07-20T10:00:00Z", "OLD-1");
  insert.run(2, -600000, "Order OLD-2", "2026-07-21T10:00:00Z", "OLD-2");
  insert.run(3, -300000, "Order 10863-98881", "2026-07-24T10:00:00Z", "10863-98881");
  insert.run(4, -200000, "Order NEW-2", "2026-07-25T10:00:00Z", "NEW-2");
  return db;
}

test.afterEach(() => database.closeDatabase());

test("historical opening uses exact 3:1:2 weights and excludes the cutoff order", () => {
  setup();
  const preview = distributions.getHistoricalPreview();
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.orders.map((order) => order.order_code), ["OLD-2", "OLD-1"]);
  assert.equal(preview.total_profit_lbp, 1500000);
  assert.deepEqual(preview.allocations.map((row) => [row.party_key, row.amount_lbp]), [
    ["ahmad", 750000],
    ["abdallah", 250000],
    ["business", 500000],
  ]);
  assert.equal(distributions.postHistorical().ok, true);
  assert.equal(distributions.getHistoricalPreview().already_initialized, true);
});

test("current distributions use the latest active 43/34/23 rule and preserve history", () => {
  const db = setup();
  distributions.postHistorical();
  const preview = distributions.getCurrentPreview();
  assert.deepEqual(new Set(preview.orders.map((order) => order.order_code)), new Set(["10863-98881", "NEW-2"]));
  assert.equal(preview.total_profit_lbp, 500000);
  assert.deepEqual(preview.allocations.map((row) => [row.party_key, row.amount_lbp]), [
    ["ahmad", 215000],
    ["abdallah", 170000],
    ["business", 115000],
  ]);
  assert.equal(distributions.postCurrent().ok, true);

  db.prepare(`
    INSERT INTO company_expenses (category, description, amount_lbp, expense_date)
    VALUES ('Other', 'Business expense', 100000, '2026-07-26')
  `).run();
  const summary = distributions.getSummary();
  assert.equal(summary.lifetime_net_profit_lbp, 2000000);
  assert.equal(summary.distributed_profit_lbp, 2000000);
  assert.equal(summary.remaining_profit_lbp, 0);
  const business = summary.participants.find((row) => row.party_key === "business");
  assert.equal(business.allocated_lbp, 615000);
  assert.equal(business.expenses_lbp, 100000);
  assert.equal(business.balance_lbp, 515000);
});

test("saving a new split creates a version and only affects later batches", () => {
  const db = setup();
  distributions.postHistorical();
  distributions.postCurrent();
  const result = distributions.createRule({ name: "Equal partners", ahmad: 40, abdallah: 40, business: 20 });
  assert.equal(result.ok, true);
  db.prepare(`
    INSERT INTO transactions (id, amount, reason, type, created_at, order_code)
    VALUES (5, -100000, 'Order NEW-3', 'gross_app_revenue', '2026-07-26', 'NEW-3')
  `).run();
  const preview = distributions.getCurrentPreview();
  assert.equal(preview.rule.name, "Equal partners");
  assert.deepEqual(preview.allocations.map((row) => row.amount_lbp), [40000, 40000, 20000]);
  const history = distributions.getHistory();
  assert.deepEqual(history.map((batch) => batch.rule_name), ["Current split", "Historical split"]);
});

test("cloud JSON backup round-trip preserves split versions and immutable batches", () => {
  setup();
  distributions.postHistorical();
  distributions.postCurrent();
  const backup = walletDb.collectBackupData();
  assert.equal(backup.schema_version, 6);
  assert.equal(backup.profit_distribution_batches.length, 2);
  walletDb.importBackupData(backup, { replace: true });
  assert.equal(distributions.getHistory().length, 2);
  assert.equal(distributions.getSummary().remaining_profit_lbp, 0);
  assert.equal(distributions.getRules().filter((rule) => rule.is_active).length, 1);
});
