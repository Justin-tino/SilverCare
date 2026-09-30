-- Run this in Supabase SQL Editor (ONE paste -> RUN). Safe to re-run.
-- Creates: seniors table (full mirror used by lib/supabaseDatabase.js)
--          + records fallback table (all other Firebase text nodes).
create table if not exists public.seniors (
    uid text primary key, username text,
    full_name text not null default 'Unnamed Senior',
    senior_id text, id_number text, face_path text, email text,
    cp_number text, address text, barangay text, city text,
    province text, dob text, sex text, civil_status text,
    kyc_status text default 'Pending', life_status text default 'Active',
    registered_by text, health_condition text, id_front_path text,
    id_back_path text, med_cert_path text, med_cert_name text,
    created_at timestamptz not null default now(),
    synced_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists seniors_senior_id_idx on public.seniors (senior_id);
create index if not exists seniors_username_idx on public.seniors (username);
create table if not exists public.records (
    node text not null, key text not null,
    data jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    primary key (node, key)
);
create index if not exists records_node_idx on public.records (node);
alter table public.seniors enable row level security;
alter table public.records enable row level security;
do $$
begin
    if not exists (select 1 from pg_policies where schemaname='public' and tablename='seniors' and policyname='service role full access') then
        create policy "service role full access" on public.seniors for all to service_role using (true) with check (true);
    end if;
    if not exists (select 1 from pg_policies where schemaname='public' and tablename='records' and policyname='service role full access') then
        create policy "service role full access" on public.records for all to service_role using (true) with check (true);
    end if;
end $$;
