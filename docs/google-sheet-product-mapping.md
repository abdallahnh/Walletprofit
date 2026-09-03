# Google Sheet to Supabase Product Mapping

Source sheet: <https://docs.google.com/spreadsheets/d/1EQz8BZ2GfyT8t-gWaZdTYtuFK9A_yJ6Aofc4s553bsk/edit?gid=376649187>

Re-inspected on 2026-09-03. The workbook has five tabs. Four are catalog sources and `Logs` is audit-only:

| Sheet tab | Catalog meaning | Rows with barcodes at inspection |
| --- | --- | ---: |
| `Products` | Active/in-stock unless the row itself says otherwise | 313 |
| `Out of Stock` | `is_available=false`, `stock_status=out_of_stock` | 0 |
| `Archive` | `is_archived=true`, retained for history | 163 |
| `Trash` | `is_trashed=true`, retained and recoverable | 4 |
| `Logs` | Not imported | — |

The four catalog tabs have the same 25-column layout. Duplicate barcodes are reported. When a barcode exists in more than one tab, conservative status precedence is `Trash` → `Archive` → `Out of Stock` → `Products`, so an inactive product is not silently reactivated.

| Google Sheet column | Supabase column | Import rule |
| --- | --- | --- |
| `f` | — | Empty in all inspected rows; ignored. |
| `Cost` | `legacy_cost_usd` | Parsed as non-negative USD when valid; original value remains in `import_source_raw`. |
| `vander price` | `vendor_price_usd` | This is the sheet's actual misspelled Vendor Price header. |
| `high price` | `selling_price_usd` | Current selling price. |
| `quantity` | `stock_quantity` | Non-negative number when valid. Zero sets `stock_status` to `out_of_stock`. |
| `item_name` | `item_name` | Preserved exactly. A blank name is invalid because Supabase requires a name. |
| `barcode` | `barcode` | Trimmed and stored as text. Empty values are rejected. |
| `description` | `description` | Preserved. |
| `measurement_unit` | `measurement_unit` | Preserved. |
| `measurement_value` | `measurement_value` | Preserved as text. |
| `brand_name` | `brand` | Preserved. |
| `image1_url` | `image_url` | Primary product image. |
| `image1_url` … `image4_url` | `image_urls` | All non-empty image values, in sheet order. |
| `category` | `category` | Preserved. |
| `subcategory` | `sub_category` | Preserved. |
| `sku` | `sku` | Preserved as text. |
| `model_name` | `model_name` | Preserved. |
| `color` | `color` | Preserved. |
| `Merchants` | `merchant_code` | Trimmed and uppercased. `B` resolves to Bassam; `T` resolves to Ahmad. Unknown values are reported and not assigned silently. |
| `Product ID` | `source_product_id` | Preserved as the legacy source identifier. |
| `Updated` | `source_updated_at` | Parsed only when it is a valid date; raw value is retained. |
| `Created` | `source_created_at` | Parsed only when it is a valid date; raw value is retained. |
| `Status` | `source_status` | Preserved. Blank status does not archive a product. |
| Sheet tab | `is_available`, `is_archived`, `is_trashed`, `stock_status` | Tab membership is authoritative for Archive, Trash, and Out of Stock. |

## Data-quality rules

- Barcodes are never converted to numbers, so long values and leading zeroes remain intact.
- Annotated prices such as `$5.00`, `20 @`, and `21*` are parsed; unrecognized text is reported and stored as raw source data rather than becoming zero.
- A missing or invalid Vendor Price remains `null` and is included in `missingVendorPrice`. New sales use valid `Cost` as an explicit fallback and snapshot `cost_source=catalog_cost_fallback`; the UI flags those item rows.
- Duplicate barcodes are collapsed before upload. Later sheet rows take precedence and the duplicate count is reported.
- Products are never deleted by this import. Existing barcodes are updated and new barcodes are inserted.
- Blank status on `Products` defaults to active. The Archive, Trash, and Out of Stock tab states override blank row status.

## Supplier identity strategy

Supabase stores the current Merchant mapping using a stable `supplier_key` (`bassam`, `ahmad`) and display name. During the later SQLite-cache stage, this stable key will resolve case-insensitively to the existing local supplier record and store its existing integer ID. It will not create a second unrelated supplier ledger.
