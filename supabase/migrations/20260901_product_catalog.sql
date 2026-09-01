-- Wallet Profit central product catalog.
-- Run after 20260715_wallet_profit_cloud.sql.
--
-- The product catalog is current operational data. Historical financial values
-- remain snapshotted in the desktop SQLite database and must not be recalculated
-- from this table.

create table if not exists public.merchant_supplier_mapping (
  merchant_code text primary key,
  supplier_key text not null unique,
  supplier_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_supplier_mapping_code_not_blank
    check (btrim(merchant_code) <> ''),
  constraint merchant_supplier_mapping_key_not_blank
    check (btrim(supplier_key) <> ''),
  constraint merchant_supplier_mapping_name_not_blank
    check (btrim(supplier_name) <> '')
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  barcode text not null unique,
  item_name text not null,
  sku text,
  brand text,
  category text,
  sub_category text,
  description text,
  model_name text,
  color text,
  measurement_unit text,
  measurement_value text,
  selling_price_usd numeric(14, 4),
  vendor_price_usd numeric(14, 4),
  legacy_cost_usd numeric(14, 4),
  merchant_code text references public.merchant_supplier_mapping(merchant_code)
    on update cascade on delete restrict,
  image_url text,
  image_urls jsonb not null default '[]'::jsonb,
  stock_quantity numeric(14, 3),
  is_available boolean not null default true,
  is_archived boolean not null default false,
  stock_status text not null default 'in_stock',
  source_product_id text,
  source_status text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  import_source_raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_barcode_not_blank check (btrim(barcode) <> ''),
  constraint products_item_name_not_blank check (btrim(item_name) <> ''),
  constraint products_selling_price_nonnegative
    check (selling_price_usd is null or selling_price_usd >= 0),
  constraint products_vendor_price_nonnegative
    check (vendor_price_usd is null or vendor_price_usd >= 0),
  constraint products_legacy_cost_nonnegative
    check (legacy_cost_usd is null or legacy_cost_usd >= 0),
  constraint products_stock_quantity_nonnegative
    check (stock_quantity is null or stock_quantity >= 0),
  constraint products_stock_status_valid
    check (stock_status in ('in_stock', 'out_of_stock')),
  constraint products_image_urls_array
    check (jsonb_typeof(image_urls) = 'array')
);

create index if not exists idx_products_active_name
  on public.products (is_archived, item_name);
create index if not exists idx_products_merchant
  on public.products (merchant_code);
create index if not exists idx_products_brand
  on public.products (brand);
create index if not exists idx_products_category
  on public.products (category);
create index if not exists idx_products_availability
  on public.products (is_available, stock_status);
create index if not exists idx_products_updated_at
  on public.products (updated_at desc);

create or replace function public.wallet_profit_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_products_updated_at on public.products;
create trigger set_products_updated_at
before update on public.products
for each row execute function public.wallet_profit_set_updated_at();

drop trigger if exists set_merchant_supplier_mapping_updated_at
  on public.merchant_supplier_mapping;
create trigger set_merchant_supplier_mapping_updated_at
before update on public.merchant_supplier_mapping
for each row execute function public.wallet_profit_set_updated_at();

insert into public.merchant_supplier_mapping
  (merchant_code, supplier_key, supplier_name)
values
  ('B', 'bassam', 'Bassam'),
  ('T', 'ahmad', 'Ahmad')
on conflict (merchant_code) do nothing;

alter table public.products enable row level security;
alter table public.merchant_supplier_mapping enable row level security;

revoke all on table public.products from anon;
revoke all on table public.merchant_supplier_mapping from anon;
grant select, insert, update on table public.products to authenticated;
grant select, insert, update on table public.merchant_supplier_mapping to authenticated;

drop policy if exists "Team can read products" on public.products;
create policy "Team can read products"
  on public.products for select to authenticated using (true);

drop policy if exists "Team can create products" on public.products;
create policy "Team can create products"
  on public.products for insert to authenticated with check (true);

drop policy if exists "Team can update products" on public.products;
create policy "Team can update products"
  on public.products for update to authenticated using (true) with check (true);

drop policy if exists "Team can read merchant mappings"
  on public.merchant_supplier_mapping;
create policy "Team can read merchant mappings"
  on public.merchant_supplier_mapping for select to authenticated using (true);

drop policy if exists "Team can create merchant mappings"
  on public.merchant_supplier_mapping;
create policy "Team can create merchant mappings"
  on public.merchant_supplier_mapping for insert to authenticated with check (true);

drop policy if exists "Team can update merchant mappings"
  on public.merchant_supplier_mapping;
create policy "Team can update merchant mappings"
  on public.merchant_supplier_mapping for update to authenticated
  using (true) with check (true);

-- DELETE is intentionally not granted. Products are archived/restored instead.
