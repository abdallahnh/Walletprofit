-- Preserve Google Sheet Trash as a status distinct from Archive.
-- Safe to run after 20260901_product_catalog.sql and safe to rerun.

alter table public.products
  add column if not exists is_trashed boolean not null default false;

create index if not exists idx_products_catalog_status
  on public.products (is_trashed, is_archived, is_available, stock_status);

comment on column public.products.is_trashed is
  'Soft-deleted in the source catalog. Retained for historical accounting and recovery.';
