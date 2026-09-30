-- PART 2/4: operational tables (claims/pensions/queue/appointments)
create table if not exists public.claims (
    id text primary key, uid text, beneficiary_name text,
    benefit_id text, benefit_name text, service_month text,
    claim_year integer, amount numeric not null default 0, notes text,
    status text not null default 'Processing', submitted_by text,
    submitted_by_name text, submitted_at bigint, processed_by text,
    processed_by_name text, processed_at bigint, approval_notes text,
    rejection_reason text, documents jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists claims_uid_idx on public.claims (uid);
create index if not exists claims_benefit_idx on public.claims (benefit_id);
create index if not exists claims_status_idx on public.claims (status);
create index if not exists claims_month_idx on public.claims (service_month);
drop trigger if exists trg_claims_touch on public.claims;
create trigger trg_claims_touch before update on public.claims
    for each row execute function public.sc_touch_updated_at();

create table if not exists public.pensions (
    id text primary key, uid text, senior_name text, senior_id text,
    amount numeric not null default 0, month text, year integer,
    status text not null default 'Pending', distribution_date text,
    distributed_at bigint, distributed_by text, distributed_by_name text,
    notes text, created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists pensions_uid_idx on public.pensions (uid);
create index if not exists pensions_month_idx on public.pensions (month);
create index if not exists pensions_status_idx on public.pensions (status);
drop trigger if exists trg_pensions_touch on public.pensions;
create trigger trg_pensions_touch before update on public.pensions
    for each row execute function public.sc_touch_updated_at();

create table if not exists public.pension_settings (
    id text primary key, amount numeric not null default 0,
    effective_month text, set_by text, set_by_name text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
drop trigger if exists trg_pension_settings_touch on public.pension_settings;
create trigger trg_pension_settings_touch before update on public.pension_settings
    for each row execute function public.sc_touch_updated_at();

create table if not exists public.transactions (
    id text primary key, uid text, senior_name text, type text,
    amount numeric not null default 0, benefit_id text, claim_id text,
    status text, created_by text, created_at_ms bigint,
    created_at timestamptz not null default now(),
    data jsonb not null default '{}'::jsonb
);
create index if not exists transactions_uid_idx on public.transactions (uid);
create index if not exists transactions_type_idx on public.transactions (type);

create table if not exists public.queue (
    id text primary key, uid text, name text, senior_id text,
    service text, date text, time text, queue_number text,
    status text not null default 'Pending', priority text, notes text,
    created_by text, created_at_ms bigint,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    data jsonb not null default '{}'::jsonb
);
create index if not exists queue_uid_idx on public.queue (uid);
create index if not exists queue_date_idx on public.queue (date);
create index if not exists queue_status_idx on public.queue (status);
drop trigger if exists trg_queue_touch on public.queue;
create trigger trg_queue_touch before update on public.queue
    for each row execute function public.sc_touch_updated_at();

create table if not exists public.appointment_requests (
    id text primary key, uid text, name text, service text, date text,
    time text, status text not null default 'Pending', notes text,
    created_at_ms bigint, created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    data jsonb not null default '{}'::jsonb
);
create index if not exists appointment_requests_uid_idx on public.appointment_requests (uid);
create index if not exists appointment_requests_status_idx on public.appointment_requests (status);
drop trigger if exists trg_appointment_requests_touch on public.appointment_requests;
create trigger trg_appointment_requests_touch before update on public.appointment_requests
    for each row execute function public.sc_touch_updated_at();

create table if not exists public.appointments (
    id text primary key, uid text, name text, service text, date text,
    time text, status text not null default 'Pending', notes text,
    created_at_ms bigint, created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    data jsonb not null default '{}'::jsonb
);
create index if not exists appointments_uid_idx on public.appointments (uid);
create index if not exists appointments_date_idx on public.appointments (date);
drop trigger if exists trg_appointments_touch on public.appointments;
create trigger trg_appointments_touch before update on public.appointments
    for each row execute function public.sc_touch_updated_at();
