-- Recovered booking schema baseline.
-- Review against the live Supabase schema before applying. This migration is additive
-- and encodes the integrity rules required by the versioned Edge Functions.

create extension if not exists pgcrypto;

create table if not exists public.edu_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

insert into public.edu_config (key, value) values
  ('price_per_session', '65'),
  ('discount_code', 'FAMILY15'),
  ('discount_price_per_session', '60')
on conflict (key) do nothing;

create table if not exists public.edu_packages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  parent_name text not null,
  parent_email text not null,
  student_email text,
  student_grade text not null,
  subject text not null,
  notes text,
  discount_code text,
  price_per_session numeric(10,2) not null,
  payment1_amount numeric(10,2) not null,
  payment2_amount numeric(10,2) not null,
  currency text not null default 'USD',
  reservation_expires_at timestamptz not null,
  payment1_status text not null default 'reserved',
  payment2_status text not null default 'not_due',
  paypal_order_id text unique,
  paypal_capture_id text unique,
  paypal_vault_id text,
  paypal_vault_status text,
  paypal_customer_id text,
  payment_source text,
  calendar_sync_status text not null default 'pending',
  calendar_sync_error text
);

alter table public.edu_packages
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists student_email text,
  add column if not exists reservation_expires_at timestamptz,
  add column if not exists currency text not null default 'USD',
  add column if not exists paypal_order_id text,
  add column if not exists paypal_capture_id text,
  add column if not exists paypal_vault_id text,
  add column if not exists paypal_vault_status text,
  add column if not exists paypal_customer_id text,
  add column if not exists payment_source text,
  add column if not exists calendar_sync_status text not null default 'pending',
  add column if not exists calendar_sync_error text;

create unique index if not exists edu_packages_paypal_order_uidx
  on public.edu_packages (paypal_order_id) where paypal_order_id is not null;
create unique index if not exists edu_packages_paypal_capture_uidx
  on public.edu_packages (paypal_capture_id) where paypal_capture_id is not null;

create table if not exists public.edu_sessions (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.edu_packages(id) on delete cascade,
  session_number smallint not null check (session_number between 1 and 4),
  session_date date not null,
  session_time text not null check (session_time in ('16:00','17:00','18:00','19:00')),
  status text not null default 'reserved',
  reservation_expires_at timestamptz,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unique (package_id, session_number)
);

alter table public.edu_sessions
  add column if not exists reservation_expires_at timestamptz,
  add column if not exists confirmed_at timestamptz;

create unique index if not exists edu_sessions_live_slot_uidx
  on public.edu_sessions (session_date, session_time)
  where status in ('reserved', 'confirmed');

alter table public.edu_packages enable row level security;
alter table public.edu_sessions enable row level security;
alter table public.edu_config enable row level security;

revoke all on public.edu_packages from anon, authenticated;
revoke all on public.edu_sessions from anon, authenticated;
revoke all on public.edu_config from anon, authenticated;

create or replace function public.edu_reserve_package(
  p_package jsonb,
  p_sessions jsonb
) returns table (package_id uuid, payment1_amount numeric, payment2_amount numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_package_id uuid := (p_package->>'id')::uuid;
  v_regular numeric(10,2);
  v_discount numeric(10,2);
  v_code text;
  v_price numeric(10,2);
  v_count integer;
begin
  if jsonb_typeof(p_sessions) <> 'array' or jsonb_array_length(p_sessions) <> 4 then
    raise exception 'exactly four sessions are required' using errcode = '22023';
  end if;

  select value::numeric into v_regular from edu_config where key = 'price_per_session';
  select value::numeric into v_discount from edu_config where key = 'discount_price_per_session';
  select value into v_code from edu_config where key = 'discount_code';
  if v_regular is null then raise exception 'price configuration is missing'; end if;

  v_price := case
    when v_code is not null and upper(coalesce(p_package->>'discount_code','')) = upper(v_code)
      then coalesce(v_discount, v_regular)
    else v_regular
  end;

  update edu_sessions
     set status = 'expired'
   where status = 'reserved'
     and reservation_expires_at <= now();

  insert into edu_packages (
    id, parent_name, parent_email, student_email, student_grade, subject, notes,
    discount_code, price_per_session, payment1_amount, payment2_amount, currency,
    reservation_expires_at, payment1_status, payment2_status
  ) values (
    v_package_id,
    left(p_package->>'parent_name', 120),
    lower(p_package->>'parent_email'),
    nullif(lower(p_package->>'student_email'), ''),
    p_package->>'student_grade',
    left(p_package->>'subject', 80),
    left(p_package->>'notes', 2000),
    nullif(left(p_package->>'discount_code', 64), ''),
    v_price, v_price * 2, v_price * 2, 'USD',
    (p_package->>'reservation_expires_at')::timestamptz,
    'reserved', 'not_due'
  );

  insert into edu_sessions (
    package_id, session_number, session_date, session_time, status, reservation_expires_at
  )
  select
    v_package_id,
    row_number() over (order by item->>'date', item->>'time')::smallint,
    (item->>'date')::date,
    left(item->>'time', 5),
    'reserved',
    (p_package->>'reservation_expires_at')::timestamptz
  from jsonb_array_elements(p_sessions) item;

  get diagnostics v_count = row_count;
  if v_count <> 4 then raise exception 'failed to reserve four sessions'; end if;

  return query select v_package_id, v_price * 2, v_price * 2;
exception
  when unique_violation then
    raise exception 'one or more sessions are unavailable' using errcode = '23505';
end;
$$;

create or replace function public.edu_release_package_reservation(p_package_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update edu_sessions
     set status = 'released'
   where package_id = p_package_id and status = 'reserved';
  update edu_packages
     set payment1_status = 'failed', updated_at = now()
   where id = p_package_id and payment1_status = 'reserved';
end;
$$;

create or replace function public.edu_finalize_payment1(
  p_package_id uuid,
  p_paypal_order_id text,
  p_capture_id text,
  p_amount numeric,
  p_currency text,
  p_vault_id text,
  p_vault_status text,
  p_paypal_customer_id text,
  p_payment_source text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_package edu_packages%rowtype;
begin
  select * into v_package from edu_packages where id = p_package_id for update;
  if not found then raise exception 'package not found'; end if;

  if v_package.payment1_status = 'captured' then
    return jsonb_build_object('already_captured', true);
  end if;
  if v_package.paypal_order_id is distinct from p_paypal_order_id then
    raise exception 'order mismatch';
  end if;
  if round(v_package.payment1_amount, 2) <> round(p_amount, 2) then
    raise exception 'amount mismatch';
  end if;
  if v_package.currency <> p_currency then raise exception 'currency mismatch'; end if;

  update edu_packages set
    payment1_status = 'captured',
    paypal_capture_id = p_capture_id,
    paypal_vault_id = p_vault_id,
    paypal_vault_status = p_vault_status,
    paypal_customer_id = p_paypal_customer_id,
    payment_source = p_payment_source,
    updated_at = now()
  where id = p_package_id;

  update edu_sessions set status = 'confirmed', confirmed_at = now()
   where package_id = p_package_id and session_number <= 2 and status = 'reserved';

  return jsonb_build_object('already_captured', false);
end;
$$;

create or replace function public.edu_finalize_comped_package(p_package_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update edu_packages
     set payment1_status = 'comped', payment2_status = 'comped', updated_at = now()
   where id = p_package_id and payment1_amount = 0 and payment2_amount = 0;
  if not found then raise exception 'package is not eligible for comping'; end if;

  update edu_sessions set status = 'confirmed', confirmed_at = now()
   where package_id = p_package_id and status = 'reserved';
end;
$$;

revoke all on function public.edu_reserve_package(jsonb, jsonb) from public;
revoke all on function public.edu_release_package_reservation(uuid) from public;
revoke all on function public.edu_finalize_payment1(uuid,text,text,numeric,text,text,text,text,text) from public;
revoke all on function public.edu_finalize_comped_package(uuid) from public;
grant execute on function public.edu_reserve_package(jsonb, jsonb) to service_role;
grant execute on function public.edu_release_package_reservation(uuid) to service_role;
grant execute on function public.edu_finalize_payment1(uuid,text,text,numeric,text,text,text,text,text) to service_role;
grant execute on function public.edu_finalize_comped_package(uuid) to service_role;
