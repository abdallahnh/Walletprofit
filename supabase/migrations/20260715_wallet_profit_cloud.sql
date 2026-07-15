-- Run this once in Supabase Dashboard > SQL Editor.
-- Team accounts must be created in Authentication > Users. Disable public sign-ups
-- so only invited/created teammates can authenticate to the shared dataset.

create table if not exists public.wallet_profit_snapshots (
  id smallint primary key default 1 check (id = 1),
  revision bigint not null default 1 check (revision > 0),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.wallet_profit_snapshots enable row level security;

revoke all on table public.wallet_profit_snapshots from anon;
grant select, insert, update on table public.wallet_profit_snapshots to authenticated;

drop policy if exists "Team can read wallet data" on public.wallet_profit_snapshots;
create policy "Team can read wallet data"
  on public.wallet_profit_snapshots
  for select
  to authenticated
  using (true);

drop policy if exists "Team can create wallet data" on public.wallet_profit_snapshots;
create policy "Team can create wallet data"
  on public.wallet_profit_snapshots
  for insert
  to authenticated
  with check (id = 1 and updated_by = (select auth.uid()));

drop policy if exists "Team can update wallet data" on public.wallet_profit_snapshots;
create policy "Team can update wallet data"
  on public.wallet_profit_snapshots
  for update
  to authenticated
  using (true)
  with check (id = 1 and updated_by = (select auth.uid()));

