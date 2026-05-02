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
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM ${table}`).run();
    // Reset AUTOINCREMENT so next inserted row starts from 1.
    db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
  });
  tx();
  return { ok: true };
}

module.exports = {
  getTableRows,
  clearTable,
  ALLOWED_TABLES,
};

