const { getDb } = require("./database");
const ordersDb = require("./orders");

const DEFAULT_CUTOFF_ORDER = "10863-98881";

function getRules() {
  const db = getDb();
  const versions = db.prepare(`
    SELECT * FROM profit_split_versions ORDER BY datetime(created_at) DESC, id DESC
  `).all();
  const members = db.prepare(`
    SELECT * FROM profit_split_members ORDER BY version_id, sort_order, party_key
  `).all();
  return versions.map((version) => {
    const rows = members.filter((member) => Number(member.version_id) === Number(version.id));
    const totalUnits = rows.reduce((sum, member) => sum + Number(member.share_units || 0), 0);
    return {
      ...version,
      is_active: !!version.is_active,
      is_historical: !!version.is_historical,
      total_units: totalUnits,
      members: rows.map((member) => ({
        ...member,
        percentage: totalUnits ? Number(member.share_units) / totalUnits * 100 : 0,
      })),
    };
  });
}

function getActiveRule() {
  return getRules().find((rule) => rule.is_active && !rule.is_historical) || null;
}

function getHistoricalRule() {
  return getRules().find((rule) => rule.is_historical) || null;
}

function getOrderRows() {
  const db = getDb();
  const sequence = new Map(db.prepare(`
    SELECT order_code, MIN(id) AS min_transaction_id, MAX(id) AS max_transaction_id
    FROM transactions
    WHERE order_code IS NOT NULL AND TRIM(order_code) <> ''
    GROUP BY order_code
  `).all().map((row) => [String(row.order_code), row]));
  return ordersDb.getOrdersReconciliation().map((order) => ({
    order_code: String(order.order_code),
    order_date: order.latest_date || order.primary_date || null,
    net_profit_lbp: order.net_profit == null ? null : Math.round(Number(order.net_profit)),
    has_unknown_supplier_cost: !!order.has_unknown_supplier_cost,
    min_transaction_id: Number(sequence.get(String(order.order_code))?.min_transaction_id || 0),
    max_transaction_id: Number(sequence.get(String(order.order_code))?.max_transaction_id || 0),
  }));
}

function getDistributedOrderCodes() {
  return new Set(getDb().prepare("SELECT order_code FROM profit_distribution_orders").all()
    .map((row) => String(row.order_code)));
}

function allocateProfit(totalProfitLbp, rule) {
  const members = rule?.members || [];
  const totalUnits = members.reduce((sum, member) => sum + Number(member.share_units || 0), 0);
  if (!members.length || totalUnits <= 0) throw new Error("The selected split rule has no valid shares");
  let allocated = 0;
  const businessIndex = Math.max(0, members.findIndex((member) => member.party_key === "business"));
  const allocations = members.map((member, index) => {
    const amount = index === businessIndex
      ? 0
      : Math.floor(Number(totalProfitLbp) * Number(member.share_units) / totalUnits);
    allocated += amount;
    return {
      party_key: member.party_key,
      display_name: member.display_name,
      share_units: Number(member.share_units),
      percentage: Number(member.share_units) / totalUnits * 100,
      amount_lbp: amount,
      is_business: member.party_key === "business",
    };
  });
  allocations[businessIndex].amount_lbp = Number(totalProfitLbp) - allocated;
  return allocations;
}

function getHistoricalPreview(cutoffOrderCode = DEFAULT_CUTOFF_ORDER) {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM profit_distribution_batches WHERE kind='historical' LIMIT 1").get();
  if (existing) return { ok: false, already_initialized: true, error: "Historical distribution is already initialized" };
  const cutoff = db.prepare(`
    SELECT MIN(id) AS min_transaction_id, MIN(created_at) AS order_date
    FROM transactions WHERE order_code=?
  `).get(String(cutoffOrderCode));
  if (!cutoff?.min_transaction_id) {
    return { ok: false, error: `Cutoff order ${cutoffOrderCode} was not found` };
  }
  const distributed = getDistributedOrderCodes();
  const orders = getOrderRows().filter((order) =>
    !distributed.has(order.order_code) &&
    order.max_transaction_id > 0 &&
    order.max_transaction_id < Number(cutoff.min_transaction_id)
  );
  const known = orders.filter((order) => order.net_profit_lbp != null);
  const missing = orders.filter((order) => order.net_profit_lbp == null);
  const totalProfit = known.reduce((sum, order) => sum + Number(order.net_profit_lbp), 0);
  const rule = getHistoricalRule();
  return {
    ok: true,
    kind: "historical",
    cutoff_order_code: String(cutoffOrderCode),
    cutoff_transaction_id: Number(cutoff.min_transaction_id),
    cutoff_order_date: cutoff.order_date || null,
    order_count: orders.length,
    known_order_count: known.length,
    missing_cost_orders: missing.length,
    total_profit_lbp: totalProfit,
    orders,
    allocations: allocateProfit(totalProfit, rule),
    rule,
  };
}

function getHistoricalCutoff() {
  return getDb().prepare(`
    SELECT cutoff_transaction_id FROM profit_distribution_batches
    WHERE kind='historical' ORDER BY id LIMIT 1
  `).get()?.cutoff_transaction_id || null;
}

function getCurrentPreview() {
  const historical = getDb().prepare(
    "SELECT id FROM profit_distribution_batches WHERE kind='historical' LIMIT 1"
  ).get();
  if (!historical) {
    return { ok: false, needs_historical: true, error: "Initialize the historical distribution first" };
  }
  const cutoff = Number(getHistoricalCutoff() || 0);
  const distributed = getDistributedOrderCodes();
  const candidates = getOrderRows().filter((order) =>
    !distributed.has(order.order_code) &&
    (!cutoff || !order.max_transaction_id || order.max_transaction_id >= cutoff)
  );
  const known = candidates.filter((order) => order.net_profit_lbp != null);
  const missing = candidates.filter((order) => order.net_profit_lbp == null);
  const totalProfit = known.reduce((sum, order) => sum + Number(order.net_profit_lbp), 0);
  const rule = getActiveRule();
  return {
    ok: true,
    kind: "regular",
    order_count: known.length,
    missing_cost_orders: missing.length,
    total_profit_lbp: totalProfit,
    orders: known,
    missing_orders: missing,
    allocations: allocateProfit(totalProfit, rule),
    rule,
  };
}

function postPreview(preview, payload = {}) {
  if (!preview?.ok) return preview;
  if (preview.kind === "regular" && preview.missing_cost_orders) {
    return { ok: false, error: `${preview.missing_cost_orders} order(s) have missing supplier costs` };
  }
  if (preview.order_count <= 0) return { ok: false, error: "There are no orders to distribute" };
  if (preview.total_profit_lbp <= 0) return { ok: false, error: "Available profit must be greater than zero" };
  const db = getDb();
  return db.transaction(() => {
    const batch = db.prepare(`
      INSERT INTO profit_distribution_batches (
        label, kind, split_version_id, total_profit_lbp, cutoff_order_code,
        cutoff_transaction_id, order_count, missing_cost_orders, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      String(payload.label || (preview.kind === "historical" ? "Opening historical distribution" : "Profit distribution")),
      preview.kind, preview.rule.id, preview.total_profit_lbp,
      preview.cutoff_order_code || null, preview.cutoff_transaction_id || null,
      preview.orders.length, preview.missing_cost_orders || 0, String(payload.notes || "")
    );
    const batchId = Number(batch.lastInsertRowid);
    const addOrder = db.prepare(`
      INSERT INTO profit_distribution_orders (batch_id, order_code, order_date, net_profit_lbp)
      VALUES (?, ?, ?, ?)
    `);
    for (const order of preview.orders) {
      addOrder.run(batchId, order.order_code, order.order_date, order.net_profit_lbp);
    }
    const addAllocation = db.prepare(`
      INSERT INTO profit_distribution_allocations (
        batch_id, party_key, display_name, share_units, amount_lbp, paid_amount_lbp, is_business
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const allocation of preview.allocations) {
      addAllocation.run(
        batchId, allocation.party_key, allocation.display_name, allocation.share_units,
        allocation.amount_lbp, allocation.is_business ? 0 : allocation.amount_lbp,
        allocation.is_business ? 1 : 0
      );
    }
    return { ok: true, batch_id: batchId };
  })();
}

function postHistorical(payload = {}) {
  return postPreview(getHistoricalPreview(payload.cutoff_order_code || DEFAULT_CUTOFF_ORDER), payload);
}

function postCurrent(payload = {}) {
  return postPreview(getCurrentPreview(), payload);
}

function createRule(payload = {}) {
  const percentages = {
    ahmad: Number(payload.ahmad),
    abdallah: Number(payload.abdallah),
    business: Number(payload.business),
  };
  if (Object.values(percentages).some((value) => !Number.isFinite(value) || value < 0)) {
    return { ok: false, error: "All percentages must be non-negative numbers" };
  }
  const total = Object.values(percentages).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 100) > 0.001) return { ok: false, error: "Split percentages must total 100%" };
  const db = getDb();
  return db.transaction(() => {
    db.prepare("UPDATE profit_split_versions SET is_active=0 WHERE is_historical=0").run();
    const version = db.prepare(`
      INSERT INTO profit_split_versions (name, is_active, is_historical, created_at)
      VALUES (?, 1, 0, datetime('now'))
    `).run(String(payload.name || "Updated split"));
    const id = Number(version.lastInsertRowid);
    const add = db.prepare(`
      INSERT INTO profit_split_members (version_id, party_key, display_name, share_units, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);
    add.run(id, "ahmad", "Ahmad Alam El Deen", Math.round(percentages.ahmad * 100), 1);
    add.run(id, "abdallah", "Abdallah", Math.round(percentages.abdallah * 100), 2);
    add.run(id, "business", "Business", Math.round(percentages.business * 100), 3);
    return { ok: true, version_id: id };
  })();
}

function getHistory() {
  const db = getDb();
  const batches = db.prepare(`
    SELECT b.*, v.name AS rule_name FROM profit_distribution_batches b
    JOIN profit_split_versions v ON v.id=b.split_version_id
    ORDER BY datetime(b.created_at) DESC, b.id DESC
  `).all();
  const allocations = db.prepare(`
    SELECT * FROM profit_distribution_allocations ORDER BY batch_id, party_key
  `).all();
  return batches.map((batch) => ({
    ...batch,
    allocations: allocations.filter((row) => Number(row.batch_id) === Number(batch.id)),
  }));
}

function getSummary() {
  const orders = getOrderRows();
  const knownLifetime = orders.filter((order) => order.net_profit_lbp != null)
    .reduce((sum, order) => sum + Number(order.net_profit_lbp), 0);
  const history = getHistory();
  const distributed = history.reduce((sum, batch) => sum + Number(batch.total_profit_lbp || 0), 0);
  const historicalInitialized = history.some((batch) => batch.kind === "historical");
  const currentPreview = historicalInitialized ? getCurrentPreview() : null;
  const remaining = currentPreview?.ok ? Number(currentPreview.total_profit_lbp || 0) : knownLifetime;
  const allocations = history.flatMap((batch) => batch.allocations || []);
  const participantMap = new Map();
  for (const row of allocations) {
    if (!participantMap.has(row.party_key)) participantMap.set(row.party_key, {
      party_key: row.party_key, display_name: row.display_name,
      allocated_lbp: 0, paid_lbp: 0, is_business: !!row.is_business,
    });
    const participant = participantMap.get(row.party_key);
    participant.allocated_lbp += Number(row.amount_lbp || 0);
    participant.paid_lbp += Number(row.paid_amount_lbp || 0);
  }
  const expenses = Number(getDb().prepare("SELECT COALESCE(SUM(amount_lbp),0) AS total FROM company_expenses").get()?.total || 0);
  const participants = Array.from(participantMap.values()).map((participant) => ({
    ...participant,
    expenses_lbp: participant.is_business ? expenses : 0,
    balance_lbp: participant.is_business
      ? participant.allocated_lbp - expenses
      : participant.allocated_lbp - participant.paid_lbp,
  }));
  return {
    lifetime_net_profit_lbp: knownLifetime,
    distributed_profit_lbp: distributed,
    remaining_profit_lbp: remaining,
    incomplete_profit_orders: orders.filter((order) => order.net_profit_lbp == null).length,
    historical_initialized: historicalInitialized,
    active_rule: getActiveRule(),
    participants,
    batches: history.length,
  };
}

module.exports = {
  DEFAULT_CUTOFF_ORDER,
  allocateProfit,
  createRule,
  getActiveRule,
  getCurrentPreview,
  getHistoricalPreview,
  getHistory,
  getRules,
  getSummary,
  postCurrent,
  postHistorical,
};
