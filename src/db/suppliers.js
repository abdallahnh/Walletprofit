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
      "SELECT id, name, color, phone, catalog_supplier_key, created_at FROM suppliers ORDER BY name COLLATE NOCASE ASC"
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
    .prepare("SELECT id, name, color, phone, catalog_supplier_key, created_at FROM suppliers WHERE id = ?")
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
    .prepare("SELECT id, name, color, phone, catalog_supplier_key, created_at FROM suppliers WHERE name = ? COLLATE NOCASE")
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

function getSupplierByCatalogKey(key) {
  const normalized = String(key || "").trim().toLowerCase();
  if (!normalized) return null;
  const row = getDb().prepare(
    "SELECT id, name, color, phone, catalog_supplier_key, created_at FROM suppliers WHERE catalog_supplier_key = ?"
  ).get(normalized);
  return row ? { ...row, color: normalizeColor(row.color, row.id) } : null;
}

function resolveCatalogSupplier({ supplier_key, supplier_name }) {
  const key = String(supplier_key || "").trim().toLowerCase();
  const name = String(supplier_name || "").trim();
  if (!key || !name) return null;
  const db = getDb();

  let supplier = db.prepare(
    "SELECT id, name, color, phone, catalog_supplier_key, created_at FROM suppliers WHERE catalog_supplier_key = ?"
  ).get(key);
  if (supplier) return { ...supplier, color: normalizeColor(supplier.color, supplier.id) };

  supplier = db.prepare(
    "SELECT id, name, color, phone, catalog_supplier_key, created_at FROM suppliers WHERE name = ? COLLATE NOCASE"
  ).get(name);
  if (supplier) {
    db.prepare("UPDATE suppliers SET catalog_supplier_key = ? WHERE id = ?").run(key, supplier.id);
    return { ...supplier, catalog_supplier_key: key, color: normalizeColor(supplier.color, supplier.id) };
  }

  const created = getOrCreateSupplier(name);
  db.prepare("UPDATE suppliers SET catalog_supplier_key = ? WHERE id = ?").run(key, created.id);
  return { ...created, catalog_supplier_key: key };
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
  const removeSupplier = db.transaction(() => {
    db.prepare("UPDATE order_meta SET supplier_id = NULL WHERE supplier_id = ?").run(id);
    db.prepare("UPDATE order_line_meta SET supplier_id = NULL WHERE supplier_id = ?").run(id);
    db.prepare("UPDATE order_items SET supplier_id = NULL WHERE supplier_id = ?").run(id);
    db.prepare("UPDATE sales SET supplier_id = NULL WHERE supplier_id = ?").run(id);
    db.prepare("DELETE FROM suppliers WHERE id = ?").run(id);
  });
  removeSupplier();
  return { ok: true };
}

function getSupplierDetails(id) {
  const db = getDb();
  const supplier = getSupplierById(Number(id));
  if (!supplier) return { ok: false, error: "Supplier not found" };

  const sales = db.prepare(`
    SELECT
      s.order_code, s.barcode, s.quantity, s.cost, s.total_sale, s.profit,
      s.created_at, s.unit_supplier_cost_usd, s.cost_source,
      COALESCE(s.item_name_snapshot, oi.item_name_snapshot, s.barcode) AS item_name,
      COALESCE(s.image_url_snapshot, oi.image_url_snapshot) AS image_url,
      COALESCE(oi.catalog_sync_status, s.catalog_sync_status) AS catalog_sync_status,
      COALESCE(olm.supplier_paid, om.supplier_paid, 0) AS supplier_paid
    FROM sales s
    LEFT JOIN order_items oi ON oi.order_code=s.order_code AND oi.barcode=s.barcode
    LEFT JOIN order_line_meta olm ON olm.order_code=s.order_code AND olm.barcode=s.barcode
    LEFT JOIN order_meta om ON om.order_code=s.order_code
    WHERE COALESCE(olm.supplier_id, s.supplier_id, om.supplier_id) = ?
    ORDER BY datetime(s.created_at) DESC, s.order_code, s.barcode
  `).all(supplier.id);

  const productMap = new Map();
  if (supplier.catalog_supplier_key) {
    const catalogRows = db.prepare(`
      SELECT barcode, item_name, image_url, vendor_price_usd, is_available,
             is_archived, stock_status
      FROM product_catalog_cache
      WHERE supplier_key=?
      ORDER BY item_name COLLATE NOCASE, barcode
    `).all(supplier.catalog_supplier_key);
    for (const product of catalogRows) {
      productMap.set(product.barcode, {
        ...product,
        units_sold: 0,
        order_codes: new Set(),
        known_cost_usd: 0,
        missing_cost_items: 0,
      });
    }
  }

  const orderMap = new Map();
  let knownCostUsd = 0;
  let paidAmountUsd = 0;
  let outstandingUsd = 0;
  let missingCostItems = 0;
  let unitsSold = 0;

  for (const sale of sales) {
    const barcode = String(sale.barcode || "");
    if (!productMap.has(barcode)) {
      productMap.set(barcode, {
        barcode,
        item_name: sale.item_name || barcode || "Unknown item",
        image_url: sale.image_url || null,
        vendor_price_usd: sale.unit_supplier_cost_usd ?? null,
        is_available: null,
        is_archived: null,
        stock_status: null,
        units_sold: 0,
        order_codes: new Set(),
        known_cost_usd: 0,
        missing_cost_items: 0,
      });
    }
    const product = productMap.get(barcode);
    const quantity = Number(sale.quantity || 0);
    product.units_sold += quantity;
    product.order_codes.add(sale.order_code);
    unitsSold += quantity;

    const missingCost = sale.cost == null;
    if (missingCost) {
      product.missing_cost_items += 1;
      missingCostItems += 1;
    } else {
      const cost = Number(sale.cost);
      product.known_cost_usd += cost;
      knownCostUsd += cost;
      if (sale.supplier_paid) paidAmountUsd += cost;
      else outstandingUsd += cost;
    }

    if (!orderMap.has(sale.order_code)) {
      orderMap.set(sale.order_code, {
        order_code: sale.order_code,
        created_at: sale.created_at,
        units: 0,
        known_cost_usd: 0,
        revenue_usd: 0,
        profit_usd: 0,
        missing_cost_items: 0,
        all_paid: true,
        barcodes: new Set(),
      });
    }
    const order = orderMap.get(sale.order_code);
    order.units += quantity;
    order.revenue_usd += Number(sale.total_sale || 0);
    order.barcodes.add(barcode);
    if (missingCost) {
      order.missing_cost_items += 1;
      order.profit_usd = null;
      order.all_paid = false;
    } else {
      order.known_cost_usd += Number(sale.cost);
      if (order.profit_usd != null) order.profit_usd += Number(sale.profit || 0);
      if (!sale.supplier_paid) order.all_paid = false;
    }
  }

  const products = Array.from(productMap.values()).map((product) => ({
    ...product,
    current_vendor_price_usd: product.vendor_price_usd,
    order_count: product.order_codes.size,
    order_codes: undefined,
    total_cost_usd: product.missing_cost_items ? null : product.known_cost_usd,
  })).sort((a, b) => Number(b.units_sold) - Number(a.units_sold) ||
    String(a.item_name).localeCompare(String(b.item_name)));

  const orders = Array.from(orderMap.values()).map((order) => ({
    ...order,
    sale_date: order.created_at,
    product_count: order.barcodes.size,
    barcodes: undefined,
    total_cost_usd: order.missing_cost_items ? null : order.known_cost_usd,
    supplier_paid: order.all_paid ? 1 : 0,
  }));

  return {
    ok: true,
    supplier,
    summary: {
      catalog_products: products.length,
      products_sold: products.filter((product) => product.units_sold > 0).length,
      units_sold: unitsSold,
      orders: orders.length,
      known_cost_usd: knownCostUsd,
      total_cost_usd: missingCostItems ? null : knownCostUsd,
      paid_amount_usd: paidAmountUsd,
      outstanding_usd: outstandingUsd,
      missing_cost_items: missingCostItems,
    },
    products,
    orders,
  };
}

module.exports = {
  getAllSuppliers,
  getSupplierById,
  getSupplierByCatalogKey,
  createSupplier,
  getOrCreateSupplier,
  updateSupplier,
  renameSupplier,
  deleteSupplier,
  getSupplierDetails,
  resolveCatalogSupplier,
  normalizeColor,
};
