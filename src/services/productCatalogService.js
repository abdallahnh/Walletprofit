const defaultCache = require("../db/productCatalogCache");

const PRODUCT_SELECT = [
  "id", "barcode", "item_name", "sku", "brand", "category", "sub_category",
  "description", "model_name", "color", "measurement_unit", "measurement_value",
  "selling_price_usd", "vendor_price_usd", "legacy_cost_usd", "merchant_code",
  "image_url", "image_urls", "stock_quantity", "is_available", "is_archived",
  "is_trashed", "stock_status", "source_product_id", "source_status", "created_at", "updated_at",
  "merchant_supplier_mapping(supplier_key,supplier_name)",
].join(",");

function validatePrice(value, field) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(field + " must be a non-negative number");
  }
  return number;
}

function cleanProductInput(input, { creating = false } = {}) {
  const allowed = [
    "item_name", "sku", "brand", "category", "sub_category", "description",
    "model_name", "color", "measurement_unit", "measurement_value",
    "selling_price_usd", "vendor_price_usd", "legacy_cost_usd", "merchant_code", "image_url",
    "image_urls", "stock_quantity", "is_available", "is_archived", "is_trashed", "stock_status",
  ];
  if (creating) allowed.unshift("barcode");
  const output = {};
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(input || {}, field)) output[field] = input[field];
  }
  if (creating) {
    output.barcode = String(output.barcode || "").trim();
    if (!output.barcode) throw new Error("Barcode is required");
  }
  if (Object.prototype.hasOwnProperty.call(output, "item_name")) {
    output.item_name = String(output.item_name || "");
    if (!output.item_name.trim()) throw new Error("Item name is required");
  } else if (creating) {
    throw new Error("Item name is required");
  }
  if (Object.prototype.hasOwnProperty.call(output, "selling_price_usd")) {
    output.selling_price_usd = validatePrice(output.selling_price_usd, "Selling price");
  }
  if (Object.prototype.hasOwnProperty.call(output, "vendor_price_usd")) {
    output.vendor_price_usd = validatePrice(output.vendor_price_usd, "Vendor price");
  }
  if (Object.prototype.hasOwnProperty.call(output, "legacy_cost_usd")) {
    output.legacy_cost_usd = validatePrice(output.legacy_cost_usd, "Cost fallback");
  }
  if (Object.prototype.hasOwnProperty.call(output, "stock_quantity")) {
    output.stock_quantity = validatePrice(output.stock_quantity, "Stock quantity");
  }
  if (Object.prototype.hasOwnProperty.call(output, "merchant_code")) {
    output.merchant_code = String(output.merchant_code || "").trim().toUpperCase() || null;
  }
  if (output.stock_status && !["in_stock", "out_of_stock"].includes(output.stock_status)) {
    throw new Error("Invalid stock status");
  }
  return output;
}

function createProductCatalogService({ cloud, cache = defaultCache } = {}) {
  if (!cloud || typeof cloud.requestAuthenticated !== "function") {
    throw new Error("An authenticated Supabase cloud service is required");
  }

  async function request(path, options) {
    return cloud.requestAuthenticated(path, options || {});
  }

  async function getMappings() {
    return request(
      "/rest/v1/merchant_supplier_mapping?select=merchant_code,supplier_key,supplier_name,updated_at&order=merchant_code.asc"
    );
  }

  async function getProducts({ includeArchived = false, includeTrashed = false, search = "" } = {}) {
    const filters = ["select=" + encodeURIComponent(PRODUCT_SELECT), "order=item_name.asc"];
    if (!includeArchived) filters.push("is_archived=eq.false");
    if (!includeTrashed) filters.push("is_trashed=eq.false");
    const term = String(search || "").trim();
    if (term) {
      const pattern = encodeURIComponent("*" + term + "*");
      filters.push(
        "or=(barcode.ilike." + pattern + ",item_name.ilike." + pattern +
        ",sku.ilike." + pattern + ",brand.ilike." + pattern + ")"
      );
    }
    return request("/rest/v1/products?" + filters.join("&"));
  }

  async function getProductByBarcode(barcode, { allowCacheFallback = true } = {}) {
    const key = String(barcode || "").trim();
    if (!key) return null;
    try {
      const rows = await request(
        "/rest/v1/products?select=" + encodeURIComponent(PRODUCT_SELECT) +
        "&barcode=eq." + encodeURIComponent(key) + "&limit=1"
      );
      if (Array.isArray(rows) && rows[0]) {
        cache.upsertProduct(rows[0]);
        return { ...rows[0], _catalog_source: "supabase" };
      }
      return null;
    } catch (error) {
      if (!allowCacheFallback) throw error;
      const cached = cache.getProductByBarcode(key);
      if (cached) return { ...cached, _catalog_error: String(error.message || error) };
      throw error;
    }
  }

  async function refreshCache() {
    const [products, mappings] = await Promise.all([
      getProducts({ includeArchived: true, includeTrashed: true }),
      getMappings(),
    ]);
    const result = cache.replaceCatalog(products, mappings);
    return { ok: true, ...result, refreshed_at: new Date().toISOString() };
  }

  async function mutate(method, path, body) {
    const rows = await request(path, {
      method,
      prefer: "return=representation",
      body,
    });
    const product = Array.isArray(rows) ? rows[0] : null;
    if (!product) throw new Error("Supabase did not return the updated product");
    cache.upsertProduct(product);
    return { ...product, _catalog_source: "supabase" };
  }

  async function createProduct(input) {
    const product = cleanProductInput(input, { creating: true });
    return mutate(
      "POST",
      "/rest/v1/products?select=" + encodeURIComponent(PRODUCT_SELECT),
      product
    );
  }

  async function updateProduct(id, input) {
    const productId = String(id || "").trim();
    if (!productId) throw new Error("Product id is required");
    const updates = cleanProductInput(input);
    if (!Object.keys(updates).length) throw new Error("No product changes supplied");
    return mutate(
      "PATCH",
      "/rest/v1/products?id=eq." + encodeURIComponent(productId) +
        "&select=" + encodeURIComponent(PRODUCT_SELECT),
      updates
    );
  }

  const archiveProduct = (id) => updateProduct(id, {
    is_archived: true,
    is_trashed: false,
    is_available: false,
    stock_status: "out_of_stock",
  });
  const restoreProduct = (id) => updateProduct(id, { is_archived: false });
  const setOutOfStock = (id) => updateProduct(id, {
    stock_status: "out_of_stock",
    is_available: false,
  });
  const setInStock = (id) => updateProduct(id, {
    stock_status: "in_stock",
    is_available: true,
  });
  const updateSellingPrice = (id, value) =>
    updateProduct(id, { selling_price_usd: value });
  const updateVendorPrice = (id, value) =>
    updateProduct(id, { vendor_price_usd: value });
  const updateSupplier = (id, merchantCode) =>
    updateProduct(id, { merchant_code: merchantCode });
  const updateImage = (id, imageUrl) =>
    updateProduct(id, { image_url: imageUrl || null });
  const searchProducts = (search, options = {}) =>
    getProducts({ ...options, search });

  function getCachedProducts(options) {
    return cache.getProducts(options || {});
  }

  return {
    archiveProduct,
    createProduct,
    getCachedProducts,
    getMappings,
    getProductByBarcode,
    getProducts,
    refreshCache,
    restoreProduct,
    searchProducts,
    setInStock,
    setOutOfStock,
    updateImage,
    updateProduct,
    updateSellingPrice,
    updateSupplier,
    updateVendorPrice,
  };
}

module.exports = {
  PRODUCT_SELECT,
  cleanProductInput,
  createProductCatalogService,
  validatePrice,
};
