const { getDb } = require("./database");

function getAllSuppliers() {
  const db = getDb();
  return db
    .prepare("SELECT id, name, created_at FROM suppliers ORDER BY name COLLATE NOCASE ASC")
    .all();
}

function getSupplierById(id) {
  const db = getDb();
  return db.prepare("SELECT id, name, created_at FROM suppliers WHERE id = ?").get(id);
}

function createSupplier(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return { ok: false, error: "Supplier name is required" };

  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE")
    .get(trimmed);

  if (existing) {
    return { ok: false, error: `Supplier "${trimmed}" already exists` };
  }

  const info = db
    .prepare("INSERT INTO suppliers (name, created_at) VALUES (?, datetime('now'))")
    .run(trimmed);

  return {
    ok: true,
    supplier: { id: info.lastInsertRowid, name: trimmed },
  };
}

function getOrCreateSupplier(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;

  const db = getDb();
  const existing = db
    .prepare("SELECT id, name, created_at FROM suppliers WHERE name = ? COLLATE NOCASE")
    .get(trimmed);

  if (existing) return existing;

  const info = db
    .prepare("INSERT INTO suppliers (name, created_at) VALUES (?, datetime('now'))")
    .run(trimmed);

  return { id: info.lastInsertRowid, name: trimmed, created_at: new Date().toISOString() };
}

function renameSupplier(id, name) {
  const trimmed = String(name || "").trim();
  if (!trimmed || !id) return { ok: false, error: "Missing id or name" };

  const db = getDb();
  try {
    db.prepare("UPDATE suppliers SET name = ? WHERE id = ?").run(trimmed, id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function deleteSupplier(id) {
  const db = getDb();
  db.prepare("UPDATE order_meta SET supplier_id = NULL WHERE supplier_id = ?").run(id);
  db.prepare("DELETE FROM suppliers WHERE id = ?").run(id);
  return { ok: true };
}

module.exports = {
  getAllSuppliers,
  getSupplierById,
  createSupplier,
  getOrCreateSupplier,
  renameSupplier,
  deleteSupplier,
};
