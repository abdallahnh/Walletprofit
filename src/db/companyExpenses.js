const { getDb } = require("./database");

const DEFAULT_CATEGORIES = [
  "Papers",
  "Phone recharge",
  "Bags",
  "Packaging",
  "Office supplies",
  "Other",
];

function getAll(opts = {}) {
  const db = getDb();
  const { from, to, category } = opts;
  const params = [];
  const where = [];

  if (from) {
    where.push("expense_date >= ?");
    params.push(from);
  }
  if (to) {
    where.push("expense_date <= ?");
    params.push(to);
  }
  if (category && category !== "all") {
    where.push("category = ?");
    params.push(category);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `
    SELECT id, category, description, amount_lbp, expense_date, notes, created_at, updated_at
    FROM company_expenses
    ${whereSql}
    ORDER BY expense_date DESC, id DESC
  `
    )
    .all(...params);

  return rows.map((r) => ({
    ...r,
    amount_lbp: Number(r.amount_lbp || 0),
  }));
}

function getSummary(opts = {}) {
  const rows = getAll(opts);
  const total = rows.reduce((sum, r) => sum + Number(r.amount_lbp || 0), 0);
  return { count: rows.length, total_lbp: total, rows };
}

function createExpense(payload = {}) {
  const category = String(payload.category || "").trim();
  const description = String(payload.description || "").trim();
  const notes = String(payload.notes || "").trim();
  const expense_date = String(payload.expense_date || "").slice(0, 10);
  const amount_lbp = Math.trunc(Number(payload.amount_lbp || 0));

  if (!category) return { ok: false, error: "Category is required" };
  if (!expense_date) return { ok: false, error: "Date is required" };
  if (amount_lbp <= 0) return { ok: false, error: "Amount must be greater than zero" };

  const db = getDb();
  const info = db
    .prepare(
      `
    INSERT INTO company_expenses (category, description, amount_lbp, expense_date, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `
    )
    .run(category, description, amount_lbp, expense_date, notes);

  return { ok: true, id: info.lastInsertRowid };
}

function updateExpense(payload = {}) {
  const id = Number(payload.id);
  if (!id) return { ok: false, error: "Missing expense id" };

  const category = String(payload.category || "").trim();
  const description = String(payload.description || "").trim();
  const notes = String(payload.notes || "").trim();
  const expense_date = String(payload.expense_date || "").slice(0, 10);
  const amount_lbp = Math.trunc(Number(payload.amount_lbp || 0));

  if (!category) return { ok: false, error: "Category is required" };
  if (!expense_date) return { ok: false, error: "Date is required" };
  if (amount_lbp <= 0) return { ok: false, error: "Amount must be greater than zero" };

  const db = getDb();
  const res = db
    .prepare(
      `
    UPDATE company_expenses
    SET category = ?, description = ?, amount_lbp = ?, expense_date = ?, notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `
    )
    .run(category, description, amount_lbp, expense_date, notes, id);

  if (res.changes === 0) return { ok: false, error: "Expense not found" };
  return { ok: true };
}

function deleteExpense(id) {
  const db = getDb();
  const res = db.prepare("DELETE FROM company_expenses WHERE id = ?").run(Number(id));
  if (res.changes === 0) return { ok: false, error: "Expense not found" };
  return { ok: true };
}

module.exports = {
  DEFAULT_CATEGORIES,
  getAll,
  getSummary,
  createExpense,
  updateExpense,
  deleteExpense,
};
