const { getDb } = require("./database");

function importProducts(rows) {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT INTO products (
      barcode,
      item_name,
      sku,
      brand,
      category,
      sub_category,
      unit_price_usd,
      cost_usd,
      measurement_unit,
      measurement_value,
      description,
      image_url,
      stock_quantity,
      updated_at
    )
    VALUES (
      @barcode,
      @item_name,
      @sku,
      @brand,
      @category,
      @sub_category,
      @unit_price_usd,
      @cost_usd,
      @measurement_unit,
      @measurement_value,
      @description,
      @image_url,
      @stock_quantity,
      datetime('now')
    )
    ON CONFLICT(barcode) DO UPDATE SET
      item_name = excluded.item_name,
      sku = excluded.sku,
      brand = excluded.brand,
      category = excluded.category,
      sub_category = excluded.sub_category,
      unit_price_usd = excluded.unit_price_usd,
      cost_usd = excluded.cost_usd,
      measurement_unit = excluded.measurement_unit,
      measurement_value = excluded.measurement_value,
      description = excluded.description,
      image_url = excluded.image_url,
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
  return db
    .prepare(
      `
    SELECT *
    FROM products
    WHERE barcode = ?
  `
    )
    .get(barcode);
}

module.exports = {
  importProducts,
  getProducts,
  findProductByBarcode,
};

