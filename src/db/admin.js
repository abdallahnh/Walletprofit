const { getDb } = require("./database");

function isSafeTableName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ""));
}

function listTables() {
  const db = getDb();
  return db
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `
    )
    .all()
    .map((r) => r.name)
    .filter((name) => isSafeTableName(name));
}

function assertTable(table) {
  if (!isSafeTableName(table)) {
    throw new Error(`Unsupported table: ${table}`);
  }
  const existingTables = listTables();
  if (!existingTables.includes(table)) {
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
  listTables,
  getTableRows,
  clearTable,
};

