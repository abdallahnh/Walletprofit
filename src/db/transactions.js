const { getDb } = require("./database");
const { normalizeType, extractOrderCode, classifyTransaction } = require("./wallet");

function mapTransactionRow(r) {
  return {
    id: r.id,
    store_id: r.store_id,
    amount: Number(r.amount) || 0,
    wallet: r.wallet || "",
    reason: r.reason || "",
    type: r.type || "",
    normalized_type: classifyTransaction(r.type, r.reason),
    created_at: r.created_at || "",
    order_code: r.order_code || extractOrderCode(r.reason),
  };
}

function getSettlements() {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT id, store_id, amount, wallet, reason, type, created_at, order_code
    FROM transactions
    ORDER BY datetime(created_at) DESC, id DESC
  `
    )
    .all();

  const settlements = [];
  let total = 0;

  for (const r of rows) {
    const mapped = mapTransactionRow(r);
    if (mapped.normalized_type !== "settlement") continue;
    total += mapped.amount;
    settlements.push(mapped);
  }

  return {
    settlements,
    total,
    count: settlements.length,
  };
}

function getAllTransactions(opts = {}) {
  const db = getDb();
  const { type } = opts;

  const rows = db
    .prepare(
      `
    SELECT id, store_id, amount, wallet, reason, type, created_at, order_code
    FROM transactions
    ORDER BY datetime(created_at) DESC, id DESC
  `
    )
    .all();

  let items = rows.map(mapTransactionRow);

  if (type && type !== "all") {
    items = items.filter((r) => r.normalized_type === type);
  }

  return items;
}

function getTransactionTypeCounts() {
  const db = getDb();
  const rows = db.prepare("SELECT type, reason FROM transactions").all();
  const counts = {};

  for (const r of rows) {
    const key = classifyTransaction(r.type, r.reason);
    counts[key] = (counts[key] || 0) + 1;
  }

  return counts;
}

module.exports = {
  getSettlements,
  getAllTransactions,
  getTransactionTypeCounts,
};
