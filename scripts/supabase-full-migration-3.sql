-- PART 3/4: catalog + health + comms tables
create table if not exists public.checkups (
    uid text primary key, payload jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);
create table if not exists public.doctors (
    id text primary key, name text, specialty text, schedule text,
    contact text, active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    data jsonb not null default '{}'::jsonb
);
drop trigger if exists trg_doctors_touch on public.doctors;
create trigger trg_doctors_touch before update on public.doctors
    for each row execute function public.sc_touch_updated_at();
create table if not exists public.health_centers (
    id text primary key, name text, address text, contact text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    data jsonb not null default '{}'::jsonb
);
drop trigger if exists trg_health_centers_touch on public.health_centers;
create trigger trg_health_centers_touch before update on public.health_centers
    for each row execute function public.sc_touch_updated_at();
create table if not exists public.barangays (
    id text primary key, name text, region text, district text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    data jsonb not null default '{}'::jsonb
);
drop trigger if exists trg_barangays_touch on public.barangays;
create trigger trg_barangays_touch before update on public.barangays
    for each row execute function public.sc_touch_updated_at();
create table if not exists public.benefits (
    id text primary key, name text, description text,
    amount numeric not null default 0, frequency text,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    data jsonb not null default '{}'::jsonb
);
drop trigger if exists trg_benefits_touch on public.benefits;
create trigger trg_benefits_touch before update on public.benefits
    for each row execute function public.sc_touch_updated_at();
create table if not exists public.attendance (
    id text primary key, queue_id text, uid text, name text, date text,
    time text, service text, status text, attended_at bigint, note text,
    recorded_by text, recorded_by_name text, recorded_at bigint,
    created_at timestamptz not null default now()
);
create index if not exists attendance_uid_idx on public.attendance (uid);
create index if not exists attendance_date_idx on public.attendance (date);
create table if not exists public.notifications (
    id text primary key, scope text not null default 'global', uid text,
    title text, body text, read boolean not null default false,
    created_at_ms bigint, created_at timestamptz not null default now()
);
create index if not exists notifications_uid_idx on public.notifications (uid);
create index if not exists notifications_scope_idx on public.notifications (scope);
create table if not exists public.audit_logs (
    id text primary key, action text, actor_uid text, actor_name text,
    actor_role text, target_uid text, doc_id text, pension numeric,
    detail text, timestamp_ms bigint,
    created_at timestamptz not null default now()
);
create index if not exists audit_logs_actor_idx on public.audit_logs (actor_uid);
create index if not exists audit_logs_action_idx on public.audit_logs (action);
create index if not exists audit_logs_ts_idx on public.audit_logs (timestamp_ms desc);
create table if not exists public.qr_codes (
    uid text primary key, code text,
    payload jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);
create table if not exists public.budget (
    id text primary key, title text, amount numeric not null default 0,
    spent numeric not null default 0, year integer,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    data jsonb not null default '{}'::jsonb
);
drop trigger if exists trg_budget_touch on public.budget;
create trigger trg_budget_touch before update on public.budget
    for each row execute function public.sc_touch_updated_at();
create table if not exists public.system_settings (
    key text primary key, value jsonb not null default 'null'::jsonb,
    updated_at timestamptz not null default now()
);
