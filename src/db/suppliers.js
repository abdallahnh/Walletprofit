const { getDb } = require("./database");

const DEFAULT_COLORS = [
  "#dbeafe",
  "#fce7f3",
  "#dcfce7",
  "#fef3c7",
  "#ede9fe",
  "#ffedd5",
  "#e0f2fe",
  "#f3e8ff",
];

function normalizeColor(color, fallbackId) {
  const raw = String(color || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  if (fallbackId != null) return DEFAULT_COLORS[Number(fallbackId) % DEFAULT_COLORS.length];
  return "#e8f4fc";
}

function normalizePhone(phone) {
  return String(phone || "").trim();
}

function getAllSuppliers() {
  const db = getDb();
  return db
    .prepare(
      "SELECT id, name, color, phone, created_at FROM suppliers ORDER BY name COLLATE NOCASE ASC"
    )
    .all()
    .map((s) => ({
      ...s,
      color: normalizeColor(s.color, s.id),
    }));
}

function getSupplierById(id) {
  const db = getDb();
  const row = db
    .prepare("SELECT id, name, color, phone, created_at FROM suppliers WHERE id = ?")
    .get(id);
  if (!row) return null;
  return { ...row, color: normalizeColor(row.color, row.id) };
}

function createSupplier(payload) {
  const name = String(typeof payload === "string" ? payload : payload?.name || "").trim();
  if (!name) return { ok: false, error: "Supplier name is required" };

  const color = normalizeColor(typeof payload === "object" ? payload?.color : null);
  const phone = normalizePhone(typeof payload === "object" ? payload?.phone : "");

  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE")
    .get(name);

  if (existing) {
    return { ok: false, error: `Supplier "${name}" already exists` };
  }

  const info = db
    .prepare(
      "INSERT INTO suppliers (name, color, phone, created_at) VALUES (?, ?, ?, datetime('now'))"
    )
    .run(name, color, phone);

  const id = info.lastInsertRowid;
  return {
    ok: true,
    supplier: {
      id,
      name,
      color: normalizeColor(color, id),
      phone,
    },
  };
}

function getOrCreateSupplier(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;

  const db = getDb();
  const existing = db
    .prepare("SELECT id, name, color, phone, created_at FROM suppliers WHERE name = ? COLLATE NOCASE")
    .get(trimmed);

  if (existing) {
    return { ...existing, color: normalizeColor(existing.color, existing.id) };
  }

  const info = db
    .prepare(
      "INSERT INTO suppliers (name, color, phone, created_at) VALUES (?, ?, ?, datetime('now'))"
    )
    .run(trimmed, normalizeColor(null), "");

  const id = info.lastInsertRowid;
  return {
    id,
    name: trimmed,
    color: normalizeColor(null, id),
    phone: "",
    created_at: new Date().toISOString(),
  };
}

function updateSupplier({ id, name, color, phone }) {
  if (!id) return { ok: false, error: "Missing supplier id" };

  const trimmed = String(name || "").trim();
  if (!trimmed) return { ok: false, error: "Supplier name is required" };

  const db = getDb();
  try {
    db.prepare(
      "UPDATE suppliers SET name = ?, color = ?, phone = ? WHERE id = ?"
    ).run(trimmed, normalizeColor(color, id), normalizePhone(phone), id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function renameSupplier(id, name) {
  const row = getSupplierById(id);
  if (!row) return { ok: false, error: "Supplier not found" };
  return updateSupplier({ id, name, color: row.color, phone: row.phone });
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
  updateSupplier,
  renameSupplier,
  deleteSupplier,
  normalizeColor,
};
