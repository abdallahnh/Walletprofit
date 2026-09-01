const { getDb } = require("./database");

function normalizeCatalogProduct(product, mappingByCode = new Map()) {
  const mapping = product.merchant_supplier_mapping ||
    mappingByCode.get(String(product.merchant_code || "")) || {};
  return {
    supabase_id: String(product.id || product.supabase_id || ""),
    barcode: String(product.barcode || "").trim(),
    item_name: String(product.item_name || ""),
    sku: product.sku ?? null,
    brand: product.brand ?? null,
    category: product.category ?? null,
    sub_category: product.sub_category ?? null,
    description: product.description ?? null,
    model_name: product.model_name ?? null,
    color: product.color ?? null,
    measurement_unit: product.measurement_unit ?? null,
    measurement_value: product.measurement_value ?? null,
    selling_price_usd: product.selling_price_usd ?? null,
    vendor_price_usd: product.vendor_price_usd ?? null,
    merchant_code: product.merchant_code ?? null,
    supplier_key: mapping.supplier_key ?? product.supplier_key ?? null,
    supplier_name: mapping.supplier_name ?? product.supplier_name ?? null,
    image_url: product.image_url ?? null,
    image_urls_json: JSON.stringify(Array.isArray(product.image_urls) ? product.image_urls : []),
    stock_quantity: product.stock_quantity ?? null,
    is_available: product.is_available === false || product.is_available === 0 ? 0 : 1,
    is_archived: product.is_archived ? 1 : 0,
    stock_status: product.stock_status || "in_stock",
    supabase_updated_at: product.updated_at ?? product.supabase_updated_at ?? null,
  };
}

function replaceCatalog(products, mappings) {
  const db = getDb();
  const mappingByCode = new Map(
    (mappings || []).map((mapping) => [String(mapping.merchant_code || ""), mapping])
  );
  const insertMapping = db.prepare(`
    INSERT INTO catalog_merchant_supplier_cache (
      merchant_code, supplier_key, supplier_name, supabase_updated_at, cached_at
    ) VALUES (?, ?, ?, ?, datetime('now'))
  `);
  const insertProduct = db.prepare(`
    INSERT INTO product_catalog_cache (
      supabase_id, barcode, item_name, sku, brand, category, sub_category,
      description, model_name, color, measurement_unit, measurement_value,
      selling_price_usd, vendor_price_usd, merchant_code, supplier_key,
      supplier_name, image_url, image_urls_json, stock_quantity, is_available,
      is_archived, stock_status, supabase_updated_at, cached_at
    ) VALUES (
      @supabase_id, @barcode, @item_name, @sku, @brand, @category, @sub_category,
      @description, @model_name, @color, @measurement_unit, @measurement_value,
      @selling_price_usd, @vendor_price_usd, @merchant_code, @supplier_key,
      @supplier_name, @image_url, @image_urls_json, @stock_quantity, @is_available,
      @is_archived, @stock_status, @supabase_updated_at, datetime('now')
    )
  `);

  const replace = db.transaction(() => {
    db.prepare("DELETE FROM product_catalog_cache").run();
    db.prepare("DELETE FROM catalog_merchant_supplier_cache").run();
    for (const mapping of mappings || []) {
      insertMapping.run(
        mapping.merchant_code,
        mapping.supplier_key,
        mapping.supplier_name,
        mapping.updated_at || null
      );
    }
    for (const product of products || []) {
      const normalized = normalizeCatalogProduct(product, mappingByCode);
      if (!normalized.supabase_id || !normalized.barcode || !normalized.item_name.trim()) continue;
      insertProduct.run(normalized);
    }
  });
  replace();
  return { products: countProducts(), mappings: countMappings() };
}

function upsertProduct(product) {
  const db = getDb();
  const mapping = product.merchant_code
    ? db.prepare("SELECT * FROM catalog_merchant_supplier_cache WHERE merchant_code = ?")
      .get(product.merchant_code)
    : null;
  const normalized = normalizeCatalogProduct(product, new Map(
    mapping ? [[String(mapping.merchant_code), mapping]] : []
  ));
  if (!normalized.supabase_id || !normalized.barcode || !normalized.item_name.trim()) {
    return { ok: false, error: "Catalog product requires id, barcode, and item name" };
  }
  db.prepare(`
    INSERT INTO product_catalog_cache (
      supabase_id, barcode, item_name, sku, brand, category, sub_category,
      description, model_name, color, measurement_unit, measurement_value,
      selling_price_usd, vendor_price_usd, merchant_code, supplier_key,
      supplier_name, image_url, image_urls_json, stock_quantity, is_available,
      is_archived, stock_status, supabase_updated_at, cached_at
    ) VALUES (
      @supabase_id, @barcode, @item_name, @sku, @brand, @category, @sub_category,
      @description, @model_name, @color, @measurement_unit, @measurement_value,
      @selling_price_usd, @vendor_price_usd, @merchant_code, @supplier_key,
      @supplier_name, @image_url, @image_urls_json, @stock_quantity, @is_available,
      @is_archived, @stock_status, @supabase_updated_at, datetime('now')
    )
    ON CONFLICT(supabase_id) DO UPDATE SET
      barcode=excluded.barcode, item_name=excluded.item_name, sku=excluded.sku,
      brand=excluded.brand, category=excluded.category, sub_category=excluded.sub_category,
      description=excluded.description, model_name=excluded.model_name, color=excluded.color,
      measurement_unit=excluded.measurement_unit, measurement_value=excluded.measurement_value,
      selling_price_usd=excluded.selling_price_usd, vendor_price_usd=excluded.vendor_price_usd,
      merchant_code=excluded.merchant_code, supplier_key=excluded.supplier_key,
      supplier_name=excluded.supplier_name, image_url=excluded.image_url,
      image_urls_json=excluded.image_urls_json, stock_quantity=excluded.stock_quantity,
      is_available=excluded.is_available, is_archived=excluded.is_archived,
      stock_status=excluded.stock_status, supabase_updated_at=excluded.supabase_updated_at,
      cached_at=datetime('now')
  `).run(normalized);
  return { ok: true };
}

function rowToProduct(row) {
  if (!row) return null;
  let imageUrls = [];
  try { imageUrls = JSON.parse(row.image_urls_json || "[]"); } catch { imageUrls = []; }
  return {
    id: row.supabase_id,
    ...row,
    image_urls: imageUrls,
    is_available: !!row.is_available,
    is_archived: !!row.is_archived,
    _catalog_source: "cache",
  };
}

function getProductByBarcode(barcode) {
  const key = String(barcode || "").trim();
  if (!key) return null;
  return rowToProduct(
    getDb().prepare("SELECT * FROM product_catalog_cache WHERE barcode = ?").get(key)
  );
}

function getProducts({ includeArchived = false, search = "" } = {}) {
  const clauses = [];
  const params = [];
  if (!includeArchived) clauses.push("is_archived = 0");
  const query = String(search || "").trim();
  if (query) {
    clauses.push("(barcode LIKE ? OR item_name LIKE ? OR sku LIKE ? OR brand LIKE ?)");
    const pattern = `%${query}%`;
    params.push(pattern, pattern, pattern, pattern);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return getDb().prepare(
    `SELECT * FROM product_catalog_cache ${where} ORDER BY item_name COLLATE NOCASE, barcode`
  ).all(...params).map(rowToProduct);
}

function getMappings() {
  return getDb().prepare(
    "SELECT * FROM catalog_merchant_supplier_cache ORDER BY merchant_code"
  ).all();
}

function countProducts() {
  return Number(getDb().prepare("SELECT COUNT(*) AS count FROM product_catalog_cache").get().count);
}

function countMappings() {
  return Number(getDb().prepare("SELECT COUNT(*) AS count FROM catalog_merchant_supplier_cache").get().count);
}

module.exports = {
  getMappings,
  getProductByBarcode,
  getProducts,
  normalizeCatalogProduct,
  replaceCatalog,
  upsertProduct,
};
