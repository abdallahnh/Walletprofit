const { getDb } = require("./database");

function importProducts(rows) {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO products (
      barcode,
      item_name,
      sku,
      brand,
      store_name,
      item_id,
      source_id,
      category,
      category_id,
      sub_category,
      sub_category_id,
      unit_price_usd,
      cost_usd,
      measurement_unit,
      measurement_value,
      description,
      image_url,
      alt_barcodes,
      import_price_usd,
      stock_quantity,
      updated_at
    )
    VALUES (
      @barcode,
      @item_name,
      @sku,
      @brand,
      @store_name,
      @item_id,
      @source_id,
      @category,
      @category_id,
      @sub_category,
      @sub_category_id,
      @unit_price_usd,
      @cost_usd,
      @measurement_unit,
      @measurement_value,
      @description,
      @image_url,
      @alt_barcodes,
      @import_price_usd,
      @stock_quantity,
      datetime('now')
    )
    ON CONFLICT(barcode) DO UPDATE SET
      item_name = excluded.item_name,
      sku = excluded.sku,
      brand = excluded.brand,
      store_name = excluded.store_name,
      item_id = excluded.item_id,
      source_id = excluded.source_id,
      category = excluded.category,
      category_id = excluded.category_id,
      sub_category = excluded.sub_category,
      sub_category_id = excluded.sub_category_id,
      unit_price_usd = excluded.unit_price_usd,
      cost_usd = excluded.cost_usd,
      measurement_unit = excluded.measurement_unit,
      measurement_value = excluded.measurement_value,
      description = excluded.description,
      image_url = excluded.image_url,
      alt_barcodes = excluded.alt_barcodes,
      import_price_usd = excluded.import_price_usd,
      stock_quantity = excluded.stock_quantity,
      updated_at = datetime('now')
  `);

  const insertMany = db.transaction((items) => {
    for (const r of items) {
      stmt.run(r);
    }
  });

  insertMany(rows);

  return { count: rows.length };
}

function getProducts() {
  const db = getDb();
  return db
    .prepare(
      `
    SELECT *
    FROM products
    ORDER BY item_name
  `
    )
    .all();
}

function findProductByBarcode(barcode) {
  const db = getDb();
  const key = String(barcode || "").trim();
  if (!key) return null;

  return db
    .prepare(
      `
    SELECT *
    FROM products
    WHERE barcode = ?
       OR alt_barcodes = ?
       OR alt_barcodes LIKE ?
       OR alt_barcodes LIKE ?
       OR alt_barcodes LIKE ?
    LIMIT 1
  `
    )
    .get(key, key, `${key},%`, `%,${key},%`, `%,${key}`);
}

function updateProduct(barcode, updates) {
  const db = getDb();
  
  const fields = [];
  const values = [];
  
  if (updates.unit_price_usd !== undefined) {
    fields.push('unit_price_usd = ?');
    values.push(updates.unit_price_usd);
  }
  
  if (updates.cost_usd !== undefined) {
    fields.push('cost_usd = ?');
    values.push(updates.cost_usd);
  }
  
  if (updates.stock_quantity !== undefined) {
    fields.push('stock_quantity = ?');
    values.push(updates.stock_quantity);
  }
  
  if (fields.length === 0) return { ok: false, error: 'No fields to update' };
  
  fields.push('updated_at = datetime(\'now\')');
  
  const sql = `
    UPDATE products 
    SET ${fields.join(', ')}
    WHERE barcode = ?
  `;
  
  values.push(barcode);
  
  const result = db.prepare(sql).run(...values);
  
  return { ok: true, changes: result.changes };
}

function exportProductsExcel() {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT 
      barcode,
      alt_barcodes,
      item_id,
      source_id,
      category_id,
      sub_category_id,
      item_name,
      store_name,
      sku,
      brand,
      category,
      sub_category,
      unit_price_usd,
      import_price_usd,
      cost_usd,
      measurement_unit,
      measurement_value,
      description,
      image_url,
      stock_quantity,
      updated_at
    FROM products
    ORDER BY item_name
  `
    )
    .all();

  return rows;
}

module.exports = {
  importProducts,
  getProducts,
  findProductByBarcode,
  updateProduct,
  exportProductsExcel,
};

