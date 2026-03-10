const { getDb } = require("./database");

const ALLOWED_TABLES = ["transactions", "order_meta", "products", "sales", "config"];

function assertTable(table) {
  if (!ALLOWED_TABLES.includes(table)) {
    throw new Error(`Unsupported table: ${table}`);
  }
}

function getTableRows(table, limit = 200) {
  assertTable(table);
  const db = getDb();
  const stmt = db.prepare(`SELECT * FROM ${table} LIMIT ?`);
  return stmt.all(limit);
}

function clearTable(table) {
  assertTable(table);
  const db = getDb();
  db.prepare(`DELETE FROM ${table}`).run();
  return { ok: true };
}

module.exports = {
  getTableRows,
  clearTable,
  ALLOWED_TABLES,
};

