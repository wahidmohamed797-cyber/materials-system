-- Run this script in the SQL Editor of the dedicated Supabase project.
-- Every row is private to the authenticated owner who created it.

create extension if not exists pgcrypto;

create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  kind text not null check (kind in ('raw', 'empties')),
  is_open boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, name)
);

alter table public.warehouses add column if not exists is_open boolean not null default true;

create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  warehouse_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 100),
  unit text not null check (unit in ('g', 'kg', 'ton', 'bag', 'pack')),
  supplier text,
  minimum_base numeric not null default 0 check (minimum_base >= 0),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (id, warehouse_id, user_id),
  unique (warehouse_id, user_id, name),
  foreign key (warehouse_id, user_id) references public.warehouses(id, user_id) on delete cascade
);

alter table public.materials drop constraint if exists materials_warehouse_id_user_id_name_key;

alter table public.materials drop constraint if exists materials_unit_check;
alter table public.materials add constraint materials_unit_check
  check (unit in ('g', 'kg', 'ton', 'bag', 'pack'));

alter table public.materials add column if not exists supplier text;
alter table public.materials add column if not exists code text;
alter table public.materials add column if not exists supplier_id uuid;

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, name)
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
  voucher_no text,
  beneficiary text,
  mix_count integer check (mix_count is null or mix_count > 0),
  issue_group_id uuid,
  supplier_id uuid,
  return_for uuid references public.stock_movements(id) on delete cascade,
  happened_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (warehouse_id, user_id) references public.warehouses(id, user_id) on delete cascade,
  foreign key (material_id, warehouse_id, user_id) references public.materials(id, warehouse_id, user_id) on delete cascade,
  check (
    (movement_type in ('opening', 'inbound', 'return', 'adjustment_in', 'transfer_in') and quantity_base > 0)
    or (movement_type in ('production_issue', 'adjustment_out', 'transfer_out') and quantity_base < 0)
  )
);

alter table public.stock_movements alter column happened_at set default now();

create index if not exists stock_movements_owner_date_idx on public.stock_movements (user_id, happened_at desc);
create index if not exists stock_movements_material_date_idx on public.stock_movements (material_id, happened_at desc);
create index if not exists stock_movements_warehouse_date_idx on public.stock_movements (warehouse_id, happened_at desc);
create index if not exists stock_movements_owner_type_date_idx on public.stock_movements (user_id, movement_type, happened_at desc);
create index if not exists materials_warehouse_idx on public.materials (warehouse_id);

alter table public.stock_movements add column if not exists voucher_no text;
alter table public.stock_movements add column if not exists beneficiary text;
alter table public.stock_movements add column if not exists mix_count integer;
alter table public.stock_movements add column if not exists issue_group_id uuid;
alter table public.stock_movements add column if not exists supplier_id uuid;
alter table public.stock_movements drop constraint if exists stock_movements_mix_count_check;
alter table public.stock_movements add constraint stock_movements_mix_count_check
  check (mix_count is null or mix_count > 0);
alter table public.stock_movements add column if not exists return_for uuid references public.stock_movements(id) on delete cascade;

create index if not exists stock_movements_voucher_idx on public.stock_movements (user_id, voucher_no);
create index if not exists stock_movements_beneficiary_idx on public.stock_movements (user_id, beneficiary);
create index if not exists stock_movements_issue_group_idx on public.stock_movements (user_id, issue_group_id) where issue_group_id is not null;
create index if not exists stock_movements_return_for_idx on public.stock_movements (return_for) where return_for is not null;

update public.materials
set code = 'C-' || upper(substr(replace(id::text, '-', ''), 1, 8))
where code is null or length(btrim(code)) = 0;

alter table public.materials alter column code set not null;

drop index if exists public.materials_user_code_idx;
create unique index if not exists materials_warehouse_code_idx
  on public.materials (user_id, warehouse_id, lower(btrim(code)));

create or replace function public.enforce_material_code_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sibling_name text;
  sibling_unit text;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text || ':' || lower(btrim(new.code)), 0));

  select m.name, m.unit into sibling_name, sibling_unit
  from public.materials m
  where m.user_id = new.user_id
    and lower(btrim(m.code)) = lower(btrim(new.code))
    and m.id <> new.id
  limit 1;

  if found and (lower(btrim(sibling_name)) <> lower(btrim(new.name)) or sibling_unit <> new.unit) then
    raise exception 'الاسم ووحدة القياس يجب أن يتطابقا لكل صنف يحمل الكود نفسه';
  end if;
  return new;
end;
$$;

drop trigger if exists materials_code_identity on public.materials;
create trigger materials_code_identity
  before insert or update of user_id, code, name, unit
  on public.materials
  for each row execute procedure public.enforce_material_code_identity();

alter table public.materials drop constraint if exists materials_supplier_fk;
alter table public.materials
  add constraint materials_supplier_fk
  foreign key (supplier_id, user_id) references public.suppliers(id, user_id) on delete set null (supplier_id);

alter table public.stock_movements drop constraint if exists stock_movements_supplier_fk;
alter table public.stock_movements
  add constraint stock_movements_supplier_fk
  foreign key (supplier_id, user_id) references public.suppliers(id, user_id) on delete set null (supplier_id);

alter table public.warehouses enable row level security;
alter table public.materials enable row level security;
alter table public.stock_movements enable row level security;
alter table public.suppliers enable row level security;

drop policy if exists "owner manages warehouses" on public.warehouses;
create policy "owner manages warehouses" on public.warehouses
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "owner manages materials" on public.materials;
create policy "owner manages materials" on public.materials
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "owner manages stock movements" on public.stock_movements;
create policy "owner manages stock movements" on public.stock_movements
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "owner manages suppliers" on public.suppliers;
create policy "owner manages suppliers" on public.suppliers
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.warehouses to authenticated;
grant select, insert, update, delete on public.materials to authenticated;
grant select, insert, update, delete on public.stock_movements to authenticated;
grant select, insert, update, delete on public.suppliers to authenticated;

-- Balances are computed in the database so the browser never has to download
-- the full movement history. Each signed-in account only sees its own rows.

create or replace function public.inventory_balances(p_as_of date default current_date)
returns table (
  material_id uuid,
  quantity_base numeric,
  last_happened_at timestamptz,
  supplier text
)
language sql
stable
security invoker
set search_path = public
as $$
  with sums as (
    select sm.material_id, sum(sm.quantity_base) as quantity_base
    from public.stock_movements sm
    where sm.user_id = auth.uid()
      and sm.happened_at::date <= p_as_of
    group by sm.material_id
  ),
  last_move as (
    select distinct on (sm.material_id)
      sm.material_id, sm.happened_at
    from public.stock_movements sm
    where sm.user_id = auth.uid()
      and sm.happened_at::date <= p_as_of
    order by sm.material_id, sm.happened_at desc, sm.created_at desc
  ),
  last_supplier as (
    select distinct on (sm.material_id)
      sm.material_id,
      coalesce(nullif(trim(sp.name), ''), nullif(trim(sm.supplier), '')) as supplier
    from public.stock_movements sm
    left join public.suppliers sp on sp.id = sm.supplier_id
    where sm.user_id = auth.uid()
      and sm.movement_type in ('opening', 'inbound')
      and sm.happened_at::date <= p_as_of
      and (
        (sm.supplier is not null and length(trim(sm.supplier)) > 0)
        or sm.supplier_id is not null
      )
    order by sm.material_id, sm.happened_at desc, sm.created_at desc
  )
  select
    m.id,
    coalesce(s.quantity_base, 0),
    lm.happened_at,
    coalesce(nullif(trim(ls.supplier), ''), nullif(trim(sp.name), ''), nullif(trim(m.supplier), ''), '—')
  from public.materials m
  left join sums s on s.material_id = m.id
  left join last_move lm on lm.material_id = m.id
  left join last_supplier ls on ls.material_id = m.id
  left join public.suppliers sp on sp.id = m.supplier_id
  where m.user_id = auth.uid();
$$;

create or replace function public.material_balance_at(p_material_id uuid, p_as_of date default current_date)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(sm.quantity_base), 0)
  from public.stock_movements sm
  where sm.user_id = auth.uid()
    and sm.material_id = p_material_id
    and sm.happened_at::date <= p_as_of;
$$;

create or replace function public.stock_movement_count(p_as_of date default current_date)
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)
  from public.stock_movements sm
  where sm.user_id = auth.uid()
    and sm.happened_at::date <= p_as_of;
$$;

create or replace function public.movement_trend(p_from date, p_to date)
returns table (day date, incoming bigint, outgoing bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with days as (
    select generate_series(p_from, p_to, interval '1 day')::date as day
  )
  select
    d.day,
    count(sm.id) filter (where sm.movement_type in ('opening', 'inbound', 'return', 'adjustment_in', 'transfer_in'))::bigint,
    count(sm.id) filter (where sm.movement_type in ('production_issue', 'adjustment_out', 'transfer_out'))::bigint
  from days d
  left join public.stock_movements sm
    on sm.user_id = auth.uid()
   and sm.happened_at::date = d.day
  group by d.day
  order by d.day;
$$;

create or replace function public.production_issue_returns()
returns table (
  issue_id uuid,
  material_id uuid,
  warehouse_id uuid,
  voucher_no text,
  beneficiary text,
  quantity_issued numeric,
  quantity_returned numeric,
  happened_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    issue.id,
    issue.material_id,
    issue.warehouse_id,
    issue.voucher_no,
    issue.beneficiary,
    abs(issue.quantity_base),
    coalesce(sum(returned.quantity_base), 0),
    issue.happened_at
  from public.stock_movements issue
  left join public.stock_movements returned
    on returned.return_for = issue.id
   and returned.user_id = issue.user_id
   and returned.movement_type = 'return'
  where issue.user_id = auth.uid()
    and issue.movement_type = 'production_issue'
  group by issue.id
  order by issue.happened_at desc;
$$;

create or replace function public.enforce_production_return_limit()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  issued_quantity numeric;
  returned_quantity numeric;
begin
  if new.movement_type <> 'return' then
    return new;
  end if;
  if new.return_for is null then
    raise exception 'يجب ربط المرتجع بإذن صرف';
  end if;

  select abs(issue.quantity_base) into issued_quantity
  from public.stock_movements issue
  where issue.id = new.return_for
    and issue.user_id = new.user_id
    and issue.movement_type = 'production_issue'
    and issue.material_id = new.material_id
    and issue.warehouse_id = new.warehouse_id
  for update;

  if issued_quantity is null then
    raise exception 'إذن الصرف لا يطابق الصنف أو المخزن المحدد';
  end if;

  select coalesce(sum(returned.quantity_base), 0) into returned_quantity
  from public.stock_movements returned
  where returned.return_for = new.return_for
    and returned.user_id = new.user_id
    and returned.movement_type = 'return'
    and (tg_op = 'INSERT' or returned.id <> new.id);

  if new.quantity_base <= 0 or returned_quantity + new.quantity_base > issued_quantity + 0.000001 then
    raise exception 'كمية المرتجع أكبر من الكمية المتبقية في إذن الصرف';
  end if;
  return new;
end;
$$;

drop trigger if exists stock_movements_return_limit on public.stock_movements;
create trigger stock_movements_return_limit
  before insert or update of movement_type, quantity_base, return_for, material_id, warehouse_id
  on public.stock_movements
  for each row execute procedure public.enforce_production_return_limit();

create or replace function public.enforce_stock_not_negative()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  minimum_balance numeric;
  warehouse_is_open boolean;
begin
  select w.is_open into warehouse_is_open
  from public.warehouses w
  where w.id = new.warehouse_id and w.user_id = new.user_id
  for update;
  if not found then
    raise exception 'المخزن غير موجود لهذا الحساب';
  end if;
  if not warehouse_is_open and new.quantity_base < 0 then
    raise exception 'لا يمكن الصرف من مخزن مغلق';
  end if;

  perform 1 from public.materials where id = new.material_id for update;
  with daily_movements as (
    select sm.happened_at::date as movement_date, sum(sm.quantity_base) as quantity_base
    from public.stock_movements sm
    where sm.material_id = new.material_id
      and sm.user_id = new.user_id
      and (tg_op = 'INSERT' or sm.id <> new.id)
    group by sm.happened_at::date
    union all
    select new.happened_at::date, new.quantity_base
  ), daily_totals as (
    select movement_date, sum(quantity_base) as quantity_base
    from daily_movements
    group by movement_date
  ), running_balances as (
    select sum(quantity_base) over (order by movement_date) as quantity_base
    from daily_totals
  )
  select min(quantity_base) into minimum_balance from running_balances;
  if minimum_balance < -0.000001 then
    raise exception 'الرصيد غير كافٍ لهذه الحركة';
  end if;
  return new;
end;
$$;

drop trigger if exists stock_movements_non_negative on public.stock_movements;
create trigger stock_movements_non_negative
  before insert or update of quantity_base, happened_at, material_id, warehouse_id
  on public.stock_movements
  for each row execute procedure public.enforce_stock_not_negative();

create or replace function public.prevent_negative_balance_after_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  minimum_balance numeric;
  warehouse_is_open boolean;
begin
  if pg_trigger_depth() > 1 then
    return old;
  end if;

  if old.quantity_base > 0 then
    select w.is_open into warehouse_is_open
    from public.warehouses w
    where w.id = old.warehouse_id and w.user_id = old.user_id
    for update;
    if not found then
      raise exception 'المخزن غير موجود لهذا الحساب';
    end if;
    if not warehouse_is_open then
      raise exception 'لا يمكن حذف حركة واردة من مخزن مغلق';
    end if;
  end if;

  with daily_totals as (
    select sm.happened_at::date as movement_date, sum(sm.quantity_base) as quantity_base
    from public.stock_movements sm
    where sm.material_id = old.material_id
      and sm.user_id = old.user_id
      and sm.id <> old.id
    group by sm.happened_at::date
  ), running_balances as (
    select sum(quantity_base) over (order by movement_date) as quantity_base
    from daily_totals
  )
  select min(quantity_base) into minimum_balance from running_balances;

  if minimum_balance < -0.000001 then
    raise exception 'لا يمكن حذف الحركة لأن ذلك سيجعل رصيد الصنف سالبًا';
  end if;
  return old;
end;
$$;

drop trigger if exists stock_movements_prevent_negative_delete on public.stock_movements;
create trigger stock_movements_prevent_negative_delete
  before delete on public.stock_movements
  for each row execute procedure public.prevent_negative_balance_after_delete();

revoke all on function public.inventory_balances(date) from public;
revoke all on function public.material_balance_at(uuid, date) from public;
revoke all on function public.stock_movement_count(date) from public;
revoke all on function public.movement_trend(date, date) from public;
revoke all on function public.production_issue_returns() from public;
revoke all on function public.prevent_negative_balance_after_delete() from public;
grant execute on function public.inventory_balances(date) to authenticated;
grant execute on function public.material_balance_at(uuid, date) to authenticated;
grant execute on function public.stock_movement_count(date) to authenticated;
grant execute on function public.movement_trend(date, date) to authenticated;
grant execute on function public.production_issue_returns() to authenticated;

create or replace function public.create_material_with_opening(
  p_warehouse_id uuid,
  p_name text,
  p_code text,
  p_unit text,
  p_supplier_id uuid,
  p_supplier text,
  p_minimum_base numeric,
  p_opening_base numeric,
  p_happened_at timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  owner_id uuid := auth.uid();
  new_material_id uuid;
begin
  if owner_id is null then
    raise exception 'يجب تسجيل الدخول لإضافة صنف';
  end if;
  if p_minimum_base < 0 or p_opening_base < 0 then
    raise exception 'الحد الأدنى والرصيد الافتتاحي لا يمكن أن يكونا سالبين';
  end if;

  insert into public.materials (
    user_id, warehouse_id, name, code, unit, supplier_id, supplier, minimum_base
  ) values (
    owner_id, p_warehouse_id, p_name, p_code, p_unit, p_supplier_id, p_supplier, p_minimum_base
  ) returning id into new_material_id;

  if p_opening_base > 0 then
    insert into public.stock_movements (
      user_id, warehouse_id, material_id, movement_type, quantity_base,
      supplier_id, supplier, happened_at, notes
    ) values (
      owner_id, p_warehouse_id, new_material_id, 'opening', p_opening_base,
      p_supplier_id, p_supplier, p_happened_at, 'رصيد افتتاحي'
    );
  end if;

  return new_material_id;
end;
$$;

create or replace function public.transfer_material(
  p_source_warehouse_id uuid,
  p_destination_warehouse_id uuid,
  p_material_id uuid,
  p_destination_code text,
  p_quantity_base numeric,
  p_happened_at timestamptz,
  p_notes text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  owner_id uuid := auth.uid();
  source_material public.materials%rowtype;
  source_kind text;
  destination_kind text;
  destination_material_id uuid;
  destination_material_unit text;
  destination_material_name text;
  new_transfer_ref uuid := gen_random_uuid();
begin
  if owner_id is null then
    raise exception 'يجب تسجيل الدخول لإجراء التحويل';
  end if;
  if p_quantity_base <= 0 then
    raise exception 'كمية التحويل يجب أن تكون أكبر من صفر';
  end if;

  select kind into source_kind
  from public.warehouses
  where id = p_source_warehouse_id and user_id = owner_id;
  select kind into destination_kind
  from public.warehouses
  where id = p_destination_warehouse_id and user_id = owner_id;
  if source_kind is null or destination_kind is null or source_kind <> destination_kind
      or p_source_warehouse_id = p_destination_warehouse_id then
    raise exception 'يجب اختيار مخزنين من نفس النوع';
  end if;

  select * into source_material
  from public.materials
  where id = p_material_id and warehouse_id = p_source_warehouse_id and user_id = owner_id
  for update;
  if not found then
    raise exception 'الصنف لا ينتمي إلى المخزن المحدد';
  end if;

  select id, unit, name into destination_material_id, destination_material_unit, destination_material_name
  from public.materials
  where warehouse_id = p_destination_warehouse_id
    and user_id = owner_id
    and lower(trim(code)) = lower(trim(source_material.code))
  limit 1;

  if destination_material_id is not null and (destination_material_unit <> source_material.unit
      or lower(trim(destination_material_name)) <> lower(trim(source_material.name))) then
    raise exception 'بيانات الصنف في المخزن الوجهة لا تطابق بيانات صنف المصدر';
  end if;

  if destination_material_id is null then
    insert into public.materials (
      user_id, warehouse_id, name, code, unit, supplier_id, supplier, minimum_base
    ) values (
      owner_id, p_destination_warehouse_id, source_material.name, source_material.code,
      source_material.unit, source_material.supplier_id, source_material.supplier, 0
    ) returning id into destination_material_id;
  end if;

  insert into public.stock_movements (
    user_id, warehouse_id, material_id, movement_type, quantity_base, transfer_ref, happened_at, notes
  ) values
    (owner_id, p_source_warehouse_id, p_material_id, 'transfer_out', -p_quantity_base, new_transfer_ref, p_happened_at, p_notes),
    (owner_id, p_destination_warehouse_id, destination_material_id, 'transfer_in', p_quantity_base, new_transfer_ref, p_happened_at, p_notes);

  return new_transfer_ref;
end;
$$;

create or replace function public.update_material_identity(
  p_material_id uuid,
  p_name text,
  p_code text,
  p_supplier_id uuid,
  p_supplier text,
  p_minimum_base numeric
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  owner_id uuid := auth.uid();
  current_material public.materials%rowtype;
  identity_code text;
begin
  if owner_id is null then
    raise exception 'يجب تسجيل الدخول لتعديل الصنف';
  end if;
  if length(trim(p_name)) not between 1 and 100 or length(trim(p_code)) not between 1 and 40 then
    raise exception 'اسم الصنف وكوده مطلوبان';
  end if;
  if p_minimum_base < 0 then
    raise exception 'الحد الأدنى لا يمكن أن يكون سالبًا';
  end if;

  select * into current_material
  from public.materials
  where id = p_material_id and user_id = owner_id
  for update;
  if not found then
    raise exception 'تعذر العثور على الصنف';
  end if;

  for identity_code in
    select distinct lower(btrim(code))
    from unnest(array[current_material.code, p_code]) as codes(code)
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended(owner_id::text || ':' || identity_code, 0));
  end loop;

  update public.materials
  set name = trim(p_name), code = trim(p_code)
  where user_id = owner_id
    and lower(btrim(code)) = lower(btrim(current_material.code));

  update public.materials
  set supplier_id = p_supplier_id,
      supplier = p_supplier,
      minimum_base = p_minimum_base
  where id = p_material_id and user_id = owner_id;
end;
$$;

revoke all on function public.create_material_with_opening(uuid, text, text, text, uuid, text, numeric, numeric, timestamptz) from public;
revoke all on function public.transfer_material(uuid, uuid, uuid, text, numeric, timestamptz, text) from public;
revoke all on function public.update_material_identity(uuid, text, text, uuid, text, numeric) from public;
grant execute on function public.create_material_with_opening(uuid, text, text, text, uuid, text, numeric, numeric, timestamptz) to authenticated;
grant execute on function public.transfer_material(uuid, uuid, uuid, text, numeric, timestamptz, text) to authenticated;
grant execute on function public.update_material_identity(uuid, text, text, uuid, text, numeric) to authenticated;

notify pgrst, 'reload schema';