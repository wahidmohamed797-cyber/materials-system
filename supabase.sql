-- Run this script in the SQL Editor of the dedicated Supabase project.
-- Every row is private to the authenticated owner who created it.

create extension if not exists pgcrypto;

create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  kind text not null check (kind in ('raw', 'empties')),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, name)
);

create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  warehouse_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 100),
  unit text not null check (unit in ('g', 'kg', 'ton', 'bag')),
  minimum_base numeric not null default 0 check (minimum_base >= 0),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (id, warehouse_id, user_id),
  unique (warehouse_id, user_id, name),
  foreign key (warehouse_id, user_id) references public.warehouses(id, user_id) on delete cascade
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  warehouse_id uuid not null,
  material_id uuid not null,
  movement_type text not null check (movement_type in ('opening', 'inbound', 'production_issue', 'return', 'adjustment_in', 'adjustment_out', 'transfer_in', 'transfer_out')),
  quantity_base numeric not null check (quantity_base <> 0),
  supplier text,
  notes text,
  transfer_ref uuid,
  happened_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (warehouse_id, user_id) references public.warehouses(id, user_id) on delete cascade,
  foreign key (material_id, warehouse_id, user_id) references public.materials(id, warehouse_id, user_id) on delete cascade,
  check (
    (movement_type in ('opening', 'inbound', 'return', 'adjustment_in', 'transfer_in') and quantity_base > 0)
    or (movement_type in ('production_issue', 'adjustment_out', 'transfer_out') and quantity_base < 0)
  )
);

create index if not exists stock_movements_owner_date_idx on public.stock_movements (user_id, happened_at desc);
create index if not exists stock_movements_material_date_idx on public.stock_movements (material_id, happened_at desc);

alter table public.warehouses enable row level security;
alter table public.materials enable row level security;
alter table public.stock_movements enable row level security;

drop policy if exists "owner manages warehouses" on public.warehouses;
create policy "owner manages warehouses" on public.warehouses
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "owner manages materials" on public.materials;
create policy "owner manages materials" on public.materials
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "owner manages stock movements" on public.stock_movements;
create policy "owner manages stock movements" on public.stock_movements
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.warehouses to authenticated;
grant select, insert, update, delete on public.materials to authenticated;
grant select, insert, update, delete on public.stock_movements to authenticated;