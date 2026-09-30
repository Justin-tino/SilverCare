-- ============================================================
-- scripts/supabase-full-migration.sql — PART 1/4: core tables
-- SilverCare — FULL Firebase -> Supabase migration schema
-- Run parts 1-4 ONCE in Supabase SQL Editor, in order.
--
-- Free-plan design (your screenshot):
--  Database (500 MB, you use 26 MB): lean text rows ONLY.
--   No base64, no images, no blobs, NO passwords.
--  File storage (1 GB, you use 0.00 GB): ALL binaries as real
--   files in PRIVATE buckets (seniors / senior-ids /
--   medical-certifications / silvercare-archive).
--  Egress (5 GB, you use 0.01 GB): files served ONLY via
--   short-lived signed URLs (300 s). Buckets stay private.
-- Firebase Auth (login) + Nodemailer/Brevo (email) stay as-is.
-- Re-running is safe (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ============================================================

create or replace function public.sc_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- PROFILES: users/{uid} minus every image/blob ---------------
create table if not exists public.profiles (
    uid text primary key, role text not null default 'senior',
    email text, username text, name text,
    first_name text, middle_name text, last_name text, extension text,
    senior_id text, osca_id text, id_number text, cp_number text,
    address text, barangay text, barangay_id text, city text,
    province text, postal_code text, citizenship text, dob text,
    sex text, civil_status text, kyc_status text default 'Pending',
    life_status text default 'Active', status text default 'Pending',
    senior_category text, priority_level text,
    pension_amount numeric, pension_suspended boolean not null default false,
    last_pension_month text, last_pension_status text,
    registered_by text, face_path text, id_front_path text,
    id_back_path text, med_cert_path text, med_cert_name text,
    health_condition text, verification_token text, duplicate_of text,
    profile_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    synced_at timestamptz not null default now()
);
create index if not exists profiles_role_idx on public.profiles (role);
create index if not exists profiles_email_idx on public.profiles (email);
create index if not exists profiles_senior_id_idx on public.profiles (senior_id);
create index if not exists profiles_barangay_idx on public.profiles (barangay_id);
create index if not exists profiles_kyc_idx on public.profiles (kyc_status);
create index if not exists profiles_life_idx on public.profiles (life_status);
drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
    for each row execute function public.sc_touch_updated_at();

-- SENIORS: legacy mirror used by lib/supabaseDatabase.js -----
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
drop trigger if exists trg_seniors_touch on public.seniors;
create trigger trg_seniors_touch before update on public.seniors
    for each row execute function public.sc_touch_updated_at();
